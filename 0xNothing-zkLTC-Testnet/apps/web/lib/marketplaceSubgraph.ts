import { PIXEL_NFT_CONTRACT_ADDRESS } from "@/lib/contract";
import { getPixelImageUrl } from "@/lib/pixelImage";
import { MARKETPLACE_SUBGRAPH_URL } from "@/lib/publicConfig";
import { readLimitedJson } from "@/lib/server/readLimitedJson";

const PIXEL_COLLECTION = PIXEL_NFT_CONTRACT_ADDRESS.toLowerCase();
const SUBGRAPH_TOKEN_BATCH_SIZE = 500;
const MAX_SUBGRAPH_RESPONSE_BYTES = 16 * 1024 * 1024;

export interface SubgraphTokenMetadata {
  tokenId: string;
  name: string;
  imageUrl: string;
  creator: `0x${string}`;
  mintedAt: number;
}

export interface SubgraphOwnedNft {
  tokenId: string;
  name: string;
  imageUrl: string;
  listing: { listingId: string; price: string } | null;
}

interface GraphQLResponse<T> {
  data?: T;
  errors?: Array<{ message?: string }>;
}

interface SubgraphMetaNode {
  hasIndexingErrors?: boolean;
  block?: { number?: string | number } | null;
}

interface TokenNode {
  id: string;
  tokenId: string;
  name: string;
  gridSize: string | null;
  pixelData: string | null;
  creator: string;
  mintedAt: string;
  mintedBlock?: string;
  mintedTx?: string;
  activeListing?: {
    listingId: string;
    price: string;
    active: boolean;
  } | null;
}

const USER_NFTS_QUERY = `
  query GetUserPixelNfts(
    $owner: Bytes!
    $collection: Bytes!
    $limit: Int!
    $skip: Int!
  ) {
    tokens(
      first: $limit
      skip: $skip
      orderBy: tokenId
      orderDirection: desc
      where: {
        owner: $owner
        collection: $collection
      }
    ) {
      id
      tokenId
      name
      gridSize
      pixelData
      creator
      mintedAt
      mintedBlock
      mintedTx
      activeListing {
        listingId
        price
        active
      }
    }
    _meta {
      hasIndexingErrors
      block { number }
    }
  }
`;

const TOKEN_METADATA_BY_IDS_QUERY = `
  query GetPixelTokensByIds(
    $collection: Bytes!
    $tokenIds: [BigInt!]!
    $limit: Int!
  ) {
    tokens(
      first: $limit
      orderBy: tokenId
      orderDirection: asc
      where: {
        collection: $collection
        tokenId_in: $tokenIds
      }
    ) {
      id
      tokenId
      name
      gridSize
      pixelData
      creator
      mintedAt
    }
  }
`;

export function hasMarketplaceSubgraph(): boolean {
  return true;
}

export async function fetchTokenMetadataFromSubgraph(
  tokenIds: string[]
): Promise<Record<string, SubgraphTokenMetadata | null>> {
  const unique = Array.from(
    new Set(
      tokenIds
        .map((id) => id.trim())
        .filter((id) => /^\d+$/.test(id))
    )
  );
  if (unique.length === 0) return {};

  const tokens: Record<string, SubgraphTokenMetadata | null> = {};
  for (const id of unique) tokens[id] = null;

  for (let start = 0; start < unique.length; start += SUBGRAPH_TOKEN_BATCH_SIZE) {
    const batch = unique.slice(start, start + SUBGRAPH_TOKEN_BATCH_SIZE);
    const data = await graphFetch<{ tokens: TokenNode[] }>(
      TOKEN_METADATA_BY_IDS_QUERY,
      {
        collection: PIXEL_COLLECTION,
        tokenIds: batch,
        limit: batch.length,
      }
    );

    for (const token of data.tokens ?? []) {
      tokens[token.tokenId] = tokenMetadataFromNode(token, token.tokenId);
    }
  }
  return tokens;
}

export async function fetchUserNftsFromSubgraph(
  address: string,
  limit = 5000,
  fresh = false,
): Promise<{
  tokens: SubgraphOwnedNft[];
  indexedBlock: number | null;
  hasIndexingErrors: boolean;
}> {
  const owner = normalizeAddress(address);
  const pageSize = Math.min(Math.max(1, limit), 500);
  const tokenNodes: TokenNode[] = [];
  let skip = 0;
  let meta: SubgraphMetaNode | null = null;

  while (tokenNodes.length < limit) {
    const data = await graphFetch<{
      tokens: TokenNode[];
      _meta?: SubgraphMetaNode | null;
    }>(USER_NFTS_QUERY, {
      owner,
      collection: PIXEL_COLLECTION,
      limit: Math.min(pageSize, limit - tokenNodes.length),
      skip,
    }, { fresh });
    const page = data.tokens ?? [];
    tokenNodes.push(...page);
    meta = data._meta ?? meta;
    if (page.length < pageSize) break;
    skip += page.length;
  }

  const tokens = tokenNodes.map((token) => {
    const activeListing = token.activeListing?.active
      ? {
          listingId: token.activeListing.listingId,
          price: token.activeListing.price,
        }
      : null;

    return {
      tokenId: token.tokenId,
      name: token.name || `Token #${token.tokenId}`,
      imageUrl: imageUrlFromToken(token),
      listing: activeListing,
    };
  });

  const indexedBlock = Number(meta?.block?.number);
  return {
    tokens,
    indexedBlock: Number.isSafeInteger(indexedBlock) ? indexedBlock : null,
    hasIndexingErrors: Boolean(meta?.hasIndexingErrors),
  };
}

async function graphFetch<T>(
  query: string,
  variables: Record<string, unknown>,
  options: { fresh?: boolean } = {},
): Promise<T> {
  const response = await fetch(MARKETPLACE_SUBGRAPH_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(8_000),
    ...(options.fresh
      ? { cache: "no-store" as const }
      : { next: { revalidate: 3 } }),
  });

  if (!response.ok) {
    throw new Error(`Marketplace subgraph request failed: ${response.status}`);
  }

  const json = await readLimitedJson<GraphQLResponse<T>>(
    response,
    MAX_SUBGRAPH_RESPONSE_BYTES,
  );
  if (json.errors?.length) {
    throw new Error(json.errors[0]?.message || "Marketplace subgraph query error");
  }
  if (!json.data) {
    throw new Error("Marketplace subgraph returned no data");
  }
  return json.data;
}

function imageUrlFromToken(token: TokenNode): string {
  if (!token.pixelData || !token.gridSize) return "";
  const gridSize = Number(token.gridSize);
  if (!Number.isFinite(gridSize) || gridSize <= 0) return "";
  return getPixelImageUrl(token.tokenId);
}

function tokenMetadataFromNode(token: TokenNode, tokenId: string): SubgraphTokenMetadata {
  return {
    tokenId,
    name: token.name || `Token #${tokenId}`,
    imageUrl: imageUrlFromToken(token),
    creator: normalizeAddress(token.creator),
    mintedAt: Number(token.mintedAt || 0),
  };
}

function normalizeAddress(address: string): `0x${string}` {
  return address.toLowerCase() as `0x${string}`;
}

