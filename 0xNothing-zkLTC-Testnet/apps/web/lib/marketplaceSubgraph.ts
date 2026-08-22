import { PIXEL_NFT_CONTRACT_ADDRESS } from "@/lib/contract";
import { getPixelImageUrl } from "@/lib/pixelImage";
import { MARKETPLACE_SUBGRAPH_URL } from "@/lib/publicConfig";

const PIXEL_COLLECTION = PIXEL_NFT_CONTRACT_ADDRESS.toLowerCase();
const SUBGRAPH_TOKEN_BATCH_SIZE = 500;

export interface SubgraphTokenMetadata {
  tokenId: string;
  name: string;
  imageUrl: string;
  creator: `0x${string}`;
  mintedAt: number;
}

export interface SubgraphListingDTO {
  listingId: string;
  collection: `0x${string}`;
  tokenId: string;
  price: string;
  seller: `0x${string}`;
  active: boolean;
}

export type SubgraphMarketEventType = "MINTED" | "LISTED" | "BOUGHT" | "CANCELLED";

export interface SubgraphMarketEventDTO {
  id: string;
  listingId: string;
  tokenId: string;
  eventType: SubgraphMarketEventType;
  price: string | null;
  seller: `0x${string}` | null;
  buyer: `0x${string}` | null;
  timestamp: number;
  blockNumber: number;
  txHash: `0x${string}`;
  token: SubgraphTokenMetadata | null;
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

interface ListingNode {
  id: string;
  listingId: string;
  collection: string;
  tokenId: string;
  price: string;
  seller: string;
  active: boolean;
}

interface MarketEventNode {
  id: string;
  listingId: string;
  tokenId: string | null;
  eventType: SubgraphMarketEventType;
  price: string | null;
  seller: string | null;
  buyer: string | null;
  timestamp: string;
  blockNumber: string;
  txHash: string;
  listing?: {
    token?: TokenNode | null;
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

const ALL_ACTIVE_LISTINGS_QUERY = `
  query GetAllActiveMarketplaceListings(
    $limit: Int!
    $skip: Int!
  ) {
    listings(
      first: $limit
      skip: $skip
      orderBy: listedAt
      orderDirection: desc
      where: { active: true }
    ) {
      id
      listingId
      collection
      tokenId
      price
      seller
      active
    }
  }
`;

const MARKET_EVENTS_QUERY = `
  query GetPixelMarketEvents(
    $collection: Bytes!
    $limit: Int!
    $skip: Int!
  ) {
    marketEvents(
      first: $limit
      skip: $skip
      orderBy: timestamp
      orderDirection: desc
      where: {
        collection: $collection
      }
    ) {
      id
      listingId
      tokenId
      eventType
      price
      seller
      buyer
      timestamp
      blockNumber
      txHash
      listing {
        token {
          id
          tokenId
          name
          gridSize
          pixelData
          creator
          mintedAt
        }
      }
    }
    _meta {
      hasIndexingErrors
      block { number }
    }
  }
`;

const MARKET_EVENTS_BY_TYPE_QUERY = `
  query GetPixelMarketEventsByType(
    $collection: Bytes!
    $eventTypes: [MarketEventType!]!
    $limit: Int!
    $skip: Int!
  ) {
    marketEvents(
      first: $limit
      skip: $skip
      orderBy: timestamp
      orderDirection: desc
      where: {
        collection: $collection
        eventType_in: $eventTypes
      }
    ) {
      id
      listingId
      tokenId
      eventType
      price
      seller
      buyer
      timestamp
      blockNumber
      txHash
      listing {
        token {
          id
          tokenId
          name
          gridSize
          pixelData
          creator
          mintedAt
        }
      }
    }
    _meta {
      hasIndexingErrors
      block { number }
    }
  }
`;

const MINTED_EVENTS_QUERY = `
  query GetPixelMintedEvents(
    $collection: Bytes!
    $limit: Int!
    $skip: Int!
  ) {
    tokens(
      first: $limit
      skip: $skip
      orderBy: mintedAt
      orderDirection: desc
      where: {
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

export async function fetchAllMarketplaceListingsFromSubgraph(
  limit = 5_000,
  fresh = false,
): Promise<SubgraphListingDTO[]> {
  const listings: SubgraphListingDTO[] = [];
  const pageSize = Math.min(Math.max(1, limit), 1_000);
  let skip = 0;

  while (listings.length < limit) {
    const data = await graphFetch<{ listings: ListingNode[] }>(
      ALL_ACTIVE_LISTINGS_QUERY,
      {
        limit: Math.min(pageSize, limit - listings.length),
        skip,
      },
      { fresh },
    );

    const page = data.listings ?? [];
    for (const listing of page) {
      if (!listing.active) continue;
      listings.push({
        listingId: listing.listingId,
        collection: normalizeAddress(listing.collection),
        tokenId: listing.tokenId,
        price: listing.price,
        seller: normalizeAddress(listing.seller),
        active: true,
      });
    }

    if (page.length < pageSize) break;
    skip += page.length;
  }

  return listings;
}

export async function fetchMarketplaceActivityFromSubgraph({
  limit = 30,
  skip = 0,
  eventTypes,
  fresh = false,
}: {
  limit?: number;
  skip?: number;
  eventTypes?: SubgraphMarketEventType[];
  fresh?: boolean;
} = {}): Promise<{
  events: SubgraphMarketEventDTO[];
  indexedBlock: number | null;
  hasIndexingErrors: boolean;
}> {
  const safeLimit = Math.min(Math.max(1, limit), 100);
  const safeSkip = Math.max(0, skip);
  const filteredTypes = eventTypes?.filter(isMarketEventType);
  const includeAll = !filteredTypes?.length;
  const includeMinted = includeAll || filteredTypes?.includes("MINTED");
  const marketTypes = includeAll
    ? (["LISTED", "BOUGHT", "CANCELLED"] as const)
    : filteredTypes.filter((type) => type !== "MINTED");
  const windowSize = Math.min(1000, safeLimit + safeSkip);

  const [marketResult, mintedResult] = await Promise.all([
    marketTypes.length
      ? fetchMarketEvents({
          limit: windowSize,
          skip: 0,
          eventTypes: includeAll ? undefined : marketTypes,
          fresh,
        })
      : Promise.resolve({ events: [], meta: null }),
    includeMinted
      ? fetchMintedEvents({ limit: windowSize, skip: 0, fresh })
      : Promise.resolve({ events: [], meta: null }),
  ]);

  const indexedBlocks = [marketResult.meta, mintedResult.meta]
    .map((meta) => Number(meta?.block?.number))
    .filter((value) => Number.isSafeInteger(value) && value >= 0);

  return {
    events: [...marketResult.events, ...mintedResult.events]
      .sort((a, b) => b.timestamp - a.timestamp || b.id.localeCompare(a.id))
      .slice(safeSkip, safeSkip + safeLimit),
    indexedBlock: indexedBlocks.length ? Math.min(...indexedBlocks) : null,
    hasIndexingErrors: Boolean(
      marketResult.meta?.hasIndexingErrors || mintedResult.meta?.hasIndexingErrors
    ),
  };
}

async function fetchMarketEvents({
  limit,
  skip,
  eventTypes,
  fresh,
}: {
  limit: number;
  skip: number;
  eventTypes?: readonly Exclude<SubgraphMarketEventType, "MINTED">[];
  fresh?: boolean;
}): Promise<{ events: SubgraphMarketEventDTO[]; meta: SubgraphMetaNode | null }> {
  const query = eventTypes?.length
    ? MARKET_EVENTS_BY_TYPE_QUERY
    : MARKET_EVENTS_QUERY;
  const variables: Record<string, unknown> = {
    collection: PIXEL_COLLECTION,
    limit,
    skip,
  };

  if (eventTypes?.length) {
    variables.eventTypes = eventTypes;
  }

  const data = await graphFetch<{
    marketEvents: MarketEventNode[];
    _meta?: SubgraphMetaNode | null;
  }>(
    query,
    variables,
    { fresh },
  );

  const events = (data.marketEvents ?? []).map((event) => {
    const token = event.listing?.token ?? null;
    const tokenId = event.tokenId || token?.tokenId || "0";
    return {
      id: event.id,
      listingId: event.listingId,
      tokenId,
      eventType: event.eventType,
      price: event.price,
      seller: normalizeNullableAddress(event.seller),
      buyer: normalizeNullableAddress(event.buyer),
      timestamp: Number(event.timestamp || 0),
      blockNumber: Number(event.blockNumber || 0),
      txHash: normalizeAddress(event.txHash),
      token: token ? tokenMetadataFromNode(token, tokenId) : null,
    };
  });
  return { events, meta: data._meta ?? null };
}

async function fetchMintedEvents({
  limit,
  skip,
  fresh,
}: {
  limit: number;
  skip: number;
  fresh?: boolean;
}): Promise<{ events: SubgraphMarketEventDTO[]; meta: SubgraphMetaNode | null }> {
  const data = await graphFetch<{
    tokens: TokenNode[];
    _meta?: SubgraphMetaNode | null;
  }>(
    MINTED_EVENTS_QUERY,
    {
      collection: PIXEL_COLLECTION,
      limit,
      skip,
    },
    { fresh },
  );

  const events: SubgraphMarketEventDTO[] = (data.tokens ?? []).map((token) => ({
    id: `minted-${token.id}`,
    listingId: "0",
    tokenId: token.tokenId,
    eventType: "MINTED" as const,
    price: null,
    seller: normalizeAddress(token.creator),
    buyer: null,
    timestamp: Number(token.mintedAt || 0),
    blockNumber: Number(token.mintedBlock || 0),
    txHash: token.mintedTx
      ? normalizeAddress(token.mintedTx)
      : "0x0000000000000000000000000000000000000000000000000000000000000000",
    token: tokenMetadataFromNode(token, token.tokenId),
  }));
  return { events, meta: data._meta ?? null };
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

  const json = (await response.json()) as GraphQLResponse<T>;
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

function normalizeNullableAddress(address: string | null | undefined): `0x${string}` | null {
  return address ? normalizeAddress(address) : null;
}

function isMarketEventType(value: string): value is SubgraphMarketEventType {
  return value === "MINTED" || value === "LISTED" || value === "BOUGHT" || value === "CANCELLED";
}
