import { NextResponse } from "next/server";
import type { Address } from "viem";
import {
  publicClient,
  PIXEL_NFT_CONTRACT_ADDRESS,
  PIXEL_MARKETPLACE_ADDRESS,
} from "@/lib/contract";
import { MarketplaceAbi, marketplaceNftKey } from "@/lib/marketplaceAbi";
import { PixelNFTABI } from "@/lib/abi";
import { getPixelImageUrl } from "@/lib/pixelImage";
import {
  fetchAllMarketplaceListingsFromSubgraph,
  fetchTokenMetadataFromSubgraph,
  hasMarketplaceSubgraph,
} from "@/lib/marketplaceSubgraph";
import { fetchValidatedErc721Metadata } from "@/lib/erc721Metadata.server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 15;

interface ListingDTO {
  listingId: string;
  collection: Address;
  tokenId: string;
  price: string;
  seller: Address;
  active: boolean;
}

interface TokenDTO {
  tokenId: string;
  name: string;
  imageUrl: string;
  creator: Address;
  mintedAt: number;
}

interface ListingsPayload {
  listings: ListingDTO[];
  tokens: Record<string, TokenDTO | null>;
}

interface CacheEntry<T> {
  value: T;
  ts: number;
}

const TOKEN_TTL = 60_000;
const LISTING_TTL = 15_000;
const MARKETPLACE_MULTICALL_BATCH_SIZE = 16_384;
const payloadCache = new Map<string, CacheEntry<ListingsPayload>>();
const pixelTokenCache = new Map<string, CacheEntry<TokenDTO | null>>();

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const force = searchParams.get("force") === "1";
  const responseHeaders = {
    "Cache-Control": force
      ? "no-store"
      : "public, s-maxage=15, stale-while-revalidate=15",
  };
  const cacheKey = "listings:all-metadata-valid";
  const cached = payloadCache.get(cacheKey);

  if (!force && cached && Date.now() - cached.ts < LISTING_TTL) {
    return NextResponse.json(cached.value, { headers: responseHeaders });
  }

  try {
    const candidates = await withTimeout(
      loadListingCandidates(),
      15_000,
      "Marketplace listing read timed out",
    );
    const purchasable = await withTimeout(
      filterPurchasableListings(candidates),
      15_000,
      "Marketplace listing validation timed out",
    );
    const tokens = await withTimeout(
      fetchTokensForListings(purchasable),
      30_000,
      "Marketplace metadata read timed out",
    );

    const listings = purchasable.filter((listing) => {
      if (isPixelCollection(listing.collection)) return true;
      return Boolean(tokens[marketplaceNftKey(listing.collection, listing.tokenId)]?.imageUrl);
    });
    const visibleKeys = new Set(
      listings.map((listing) => marketplaceNftKey(listing.collection, listing.tokenId)),
    );
    const visibleTokens = Object.fromEntries(
      Object.entries(tokens).filter(([key]) => visibleKeys.has(key)),
    );
    const payload = { listings, tokens: visibleTokens };
    payloadCache.set(cacheKey, { value: payload, ts: Date.now() });
    return NextResponse.json(payload, { headers: responseHeaders });
  } catch (error) {
    console.error("[marketplace] listing load failed:", error);
    if (cached) return NextResponse.json(cached.value, { headers: responseHeaders });
    return NextResponse.json(
      { error: "Marketplace data unavailable" },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}

async function loadListingCandidates(): Promise<ListingDTO[]> {
  if (hasMarketplaceSubgraph()) {
    try {
      const listings = await fetchAllMarketplaceListingsFromSubgraph();
      return listings.map((listing) => ({
        listingId: listing.listingId,
        collection: listing.collection,
        tokenId: listing.tokenId,
        price: listing.price,
        seller: listing.seller,
        active: listing.active,
      }));
    } catch (error) {
      console.warn("[marketplace] subgraph listing fetch failed; using RPC:", error);
    }
  }
  return fetchActiveListingsOnchain();
}

async function fetchActiveListingsOnchain(): Promise<ListingDTO[]> {
  const ids: bigint[] = [];
  const seenIds = new Set<string>();
  const pageSize = 100n;
  let offset = 0n;

  while (true) {
    const page = (await publicClient.readContract({
      address: PIXEL_MARKETPLACE_ADDRESS,
      abi: MarketplaceAbi,
      functionName: "getActiveListings",
      args: [offset, pageSize],
    })) as bigint[];
    if (page.length === 0) break;

    for (const id of page) {
      const key = id.toString();
      if (!seenIds.has(key)) {
        seenIds.add(key);
        ids.push(id);
      }
    }
    if (page.length < Number(pageSize)) break;
    const nextOffset = page[page.length - 1];
    if (nextOffset <= offset) break;
    offset = nextOffset;
  }

  if (ids.length === 0) return [];
  const results = await publicClient.multicall({
    allowFailure: true,
    batchSize: MARKETPLACE_MULTICALL_BATCH_SIZE,
    contracts: ids.map((id) => ({
      address: PIXEL_MARKETPLACE_ADDRESS,
      abi: MarketplaceAbi,
      functionName: "listings" as const,
      args: [id] as const,
    })),
  });

  const listings: ListingDTO[] = [];
  for (let index = 0; index < ids.length; index++) {
    const result = results[index];
    if (!result || result.status !== "success") continue;
    const tuple = result.result as readonly [Address, bigint, bigint, Address, boolean];
    if (!tuple[4]) continue;
    listings.push({
      listingId: ids[index].toString(),
      collection: tuple[0],
      tokenId: tuple[1].toString(),
      price: tuple[2].toString(),
      seller: tuple[3],
      active: true,
    });
  }
  return listings;
}

async function filterPurchasableListings(listings: ListingDTO[]): Promise<ListingDTO[]> {
  if (listings.length === 0) return [];
  const results = await publicClient.multicall({
    allowFailure: true,
    batchSize: MARKETPLACE_MULTICALL_BATCH_SIZE,
    contracts: listings.flatMap((listing) => {
      const tokenId = BigInt(listing.tokenId);
      return [
        {
          address: listing.collection,
          abi: PixelNFTABI,
          functionName: "ownerOf" as const,
          args: [tokenId] as const,
        },
        {
          address: listing.collection,
          abi: PixelNFTABI,
          functionName: "getApproved" as const,
          args: [tokenId] as const,
        },
        {
          address: listing.collection,
          abi: PixelNFTABI,
          functionName: "isApprovedForAll" as const,
          args: [listing.seller, PIXEL_MARKETPLACE_ADDRESS] as const,
        },
      ];
    }),
  });

  return listings.filter((listing, index) => {
    const owner = results[index * 3];
    const approved = results[index * 3 + 1];
    const approvedForAll = results[index * 3 + 2];
    const ownerMatches =
      owner?.status === "success" &&
      String(owner.result).toLowerCase() === listing.seller.toLowerCase();
    const tokenApproved =
      approved?.status === "success" &&
      String(approved.result).toLowerCase() === PIXEL_MARKETPLACE_ADDRESS.toLowerCase();
    const collectionApproved =
      approvedForAll?.status === "success" && approvedForAll.result === true;
    return ownerMatches && (tokenApproved || collectionApproved);
  });
}

async function fetchTokensForListings(
  listings: ListingDTO[],
): Promise<Record<string, TokenDTO | null>> {
  const output: Record<string, TokenDTO | null> = {};
  const pixelListings = listings.filter((listing) => isPixelCollection(listing.collection));
  const pixelIds = Array.from(new Set(pixelListings.map((listing) => listing.tokenId)));

  let subgraphTokens: Awaited<ReturnType<typeof fetchTokenMetadataFromSubgraph>> = {};
  if (pixelIds.length > 0 && hasMarketplaceSubgraph()) {
    try {
      subgraphTokens = await fetchTokenMetadataFromSubgraph(pixelIds);
    } catch (error) {
      console.warn("[marketplace] pixel metadata subgraph failed; using RPC:", error);
    }
  }

  const missingPixelIds = pixelIds.filter((tokenId) => !subgraphTokens[tokenId]?.imageUrl);
  const onchainPixelTokens = await fetchPixelTokensOnchain(missingPixelIds);
  for (const listing of pixelListings) {
    const metadata = subgraphTokens[listing.tokenId] ?? onchainPixelTokens[listing.tokenId] ?? null;
    output[marketplaceNftKey(listing.collection, listing.tokenId)] = metadata;
  }

  const genericListings = listings.filter((listing) => !isPixelCollection(listing.collection));
  const genericMetadata = await fetchValidatedErc721Metadata(
    genericListings.map((listing) => ({
      collection: listing.collection,
      tokenId: listing.tokenId,
    })),
  );
  Object.assign(output, genericMetadata);
  return output;
}

async function fetchPixelTokensOnchain(
  tokenIds: string[],
): Promise<Record<string, TokenDTO | null>> {
  const output: Record<string, TokenDTO | null> = {};
  const missing: string[] = [];
  for (const tokenId of tokenIds) {
    const cached = pixelTokenCache.get(tokenId);
    if (cached && Date.now() - cached.ts < TOKEN_TTL) {
      output[tokenId] = cached.value;
    } else {
      missing.push(tokenId);
    }
  }
  if (missing.length === 0) return output;

  const results = await publicClient.multicall({
    allowFailure: true,
    batchSize: MARKETPLACE_MULTICALL_BATCH_SIZE,
    contracts: missing.map((tokenId) => ({
      address: PIXEL_NFT_CONTRACT_ADDRESS,
      abi: PixelNFTABI,
      functionName: "tokenData" as const,
      args: [BigInt(tokenId)] as const,
    })),
  });

  for (let index = 0; index < missing.length; index++) {
    const tokenId = missing[index];
    const result = results[index];
    let metadata: TokenDTO | null = null;
    if (result?.status === "success") {
      const tuple = result.result as readonly [string, bigint, string, Address, bigint, string];
      const imageUrl = tuple[2] && tuple[1]
        ? getPixelImageUrl(tokenId)
        : "";
      metadata = imageUrl
        ? {
            tokenId,
            name: tuple[0] || `Token #${tokenId}`,
            imageUrl,
            creator: tuple[3],
            mintedAt: Number(tuple[4]),
          }
        : null;
    }
    pixelTokenCache.set(tokenId, { value: metadata, ts: Date.now() });
    output[tokenId] = metadata;
  }

  while (pixelTokenCache.size > 4_096) {
    const oldestKey = pixelTokenCache.keys().next().value;
    if (oldestKey === undefined) break;
    pixelTokenCache.delete(oldestKey);
  }
  return output;
}

function isPixelCollection(collection: string): boolean {
  return collection.toLowerCase() === PIXEL_NFT_CONTRACT_ADDRESS.toLowerCase();
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}
