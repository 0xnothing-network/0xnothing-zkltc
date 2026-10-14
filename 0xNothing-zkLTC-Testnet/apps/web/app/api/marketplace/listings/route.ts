import { PIXEL_COLLECTIONS, isPixelCollection, isPackedPixelCollection, pixelTokenKey } from "@/lib/pixelCollections";
import { NextResponse } from "next/server";
import type { Address } from "viem";
import { publicClient } from "@/lib/contract";
import { NFT_NUSD_ADDRESS, NUSD_MARKETPLACE_ADDRESS } from "@/lib/nusdMarketplaceConfig";
import { readNusdMarket } from "@/lib/nusdMarketplace";
import { PixelClassicABI } from "@/lib/abi";
import { PixelNFTABI } from "@/lib/pixelNftAbi";
import { getPixelImageUrl } from "@/lib/pixelImage";
import { fetchValidatedErc721Metadata } from "@/lib/erc721Metadata.server";
import { createBoundedCache } from "@/lib/boundedCache";
import { publicCdnCacheHeaders } from "@/lib/server/cdnCache";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

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
  currency: "NUSD";
  marketplace: Address;
  blockNumber: string;
  totalCount: string;
  page: number;
  listings: ListingDTO[];
  tokens: Record<string, TokenDTO | null>;
}

const MARKETPLACE_MULTICALL_BATCH_SIZE = 16_384;
const payloadCache = createBoundedCache<ListingsPayload>({ maxEntries: 256, ttlMs: 3_000, maxInFlight: 32 });
// `force=1` is public: a forced read is reused for 2 s so repeating it cannot multiply RPC load.
const forcedPayloadCache = createBoundedCache<ListingsPayload>({ maxEntries: 256, ttlMs: 2_000, maxInFlight: 32 });
const pixelTokenCache = createBoundedCache<TokenDTO | null>({ maxEntries: 4_096, ttlMs: 60_000 });

export async function GET(request: Request) {
  if (!NUSD_MARKETPLACE_ADDRESS) return NextResponse.json({ error: "NUSD marketplace is not configured" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  const params = new URL(request.url).searchParams;
  const rawPage = params.get("page") ?? "0";
  const page = Number(rawPage);
  if (!/^\d{1,16}$/.test(rawPage) || !Number.isSafeInteger(page)) return NextResponse.json({ error: "Invalid marketplace page" }, { status: 400, headers: { "Cache-Control": "no-store" } });
  const force = params.get("force") === "1";
  const key = `${NUSD_MARKETPLACE_ADDRESS}:${page}`;
  const load = async (): Promise<ListingsPayload> => {
    const state = await readNusdMarket(publicClient, NUSD_MARKETPLACE_ADDRESS!, NFT_NUSD_ADDRESS, undefined, page);
    const listings = state.listings.filter((listing) => listing.active).map((listing) => ({
      listingId: listing.id.toString(), collection: listing.collection, tokenId: listing.tokenId.toString(),
      price: listing.price.toString(), seller: listing.seller, active: listing.active,
    }));
    const [pixel, generic] = await Promise.all([fetchPixelTokensForListings(listings), fetchGenericTokensForListings(listings)]);
    return { currency: "NUSD", marketplace: NUSD_MARKETPLACE_ADDRESS!, blockNumber: state.blockNumber.toString(), totalCount: state.listingCount.toString(), page, listings, tokens: { ...pixel, ...generic } };
  };
  try {
    const payload = force ? await forcedPayloadCache.load(key, load) : await payloadCache.load(key, load);
    if (force) payloadCache.set(key, payload);
    return NextResponse.json(payload, { headers: force ? { "Cache-Control": "private, no-store" } : publicCdnCacheHeaders("public, max-age=0, s-maxage=3, stale-while-revalidate=3", 3, 3) });
  } catch {
    return NextResponse.json({ error: "NUSD marketplace listings are unavailable" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}

async function fetchPixelTokensForListings(
  listings: ListingDTO[],
): Promise<Record<string, TokenDTO | null>> {
  const output: Record<string, TokenDTO | null> = {};
  for (const entry of PIXEL_COLLECTIONS) {
    const pixelListings = listings.filter((listing) => listing.collection.toLowerCase() === entry.address.toLowerCase());
    const pixelIds = Array.from(new Set(pixelListings.map((listing) => listing.tokenId)));
    if (!pixelIds.length) continue;
    const onchain = await fetchPixelTokensOnchain(pixelIds, entry.address);
    for (const tokenId of pixelIds) {
      output[pixelTokenKey(entry.address, tokenId)] = onchain[tokenId] ?? null;
    }
  }

  return output;
}

async function fetchGenericTokensForListings(
  listings: ListingDTO[],
): Promise<Record<string, TokenDTO | null>> {
  const genericListings = listings.filter((listing) => !isPixelCollection(listing.collection));
  if (genericListings.length === 0) return {};
  return fetchValidatedErc721Metadata(
    genericListings.map((listing) => ({
      collection: listing.collection,
      tokenId: listing.tokenId,
    })),
  );
}

async function fetchPixelTokensOnchain(
  tokenIds: string[], collection: Address,
): Promise<Record<string, TokenDTO | null>> {
  const output: Record<string, TokenDTO | null> = {};
  const missing: string[] = [];
  for (const tokenId of tokenIds) {
    const cached = pixelTokenCache.get(pixelTokenKey(collection, tokenId));
    // A cached null is a token without a usable image; only `undefined` is a miss.
    if (cached !== undefined) {
      output[tokenId] = cached;
    } else {
      missing.push(tokenId);
    }
  }
  if (missing.length === 0) return output;

  const isPacked = isPackedPixelCollection(collection);
  const results = await publicClient.multicall({
    allowFailure: true,
    batchSize: MARKETPLACE_MULTICALL_BATCH_SIZE,
    contracts: missing.map((tokenId) => isPacked ? {
      address: collection,
      abi: PixelNFTABI,
      functionName: "tokenPackedData" as const,
      args: [BigInt(tokenId)] as const,
    } : {
      address: collection,
      abi: PixelClassicABI,
      functionName: "tokenData" as const,
      args: [BigInt(tokenId)] as const,
    }),
  });

  for (let index = 0; index < missing.length; index++) {
    const tokenId = missing[index];
    const result = results[index];
    let metadata: TokenDTO | null = null;
    if (result?.status === "success") {
      const packed = result.result as readonly [string, string, bigint, string, Address, bigint, string];
      const tuple = isPacked
        ? [packed[0], packed[2], packed[3], packed[4], packed[5], packed[6]] as const
        : result.result as readonly [string, bigint, string, Address, bigint, string];
      const imageUrl = tuple[2] && tuple[1]
        ? getPixelImageUrl(tokenId, collection)
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
    pixelTokenCache.set(pixelTokenKey(collection, tokenId), metadata);
    output[tokenId] = metadata;
  }

  return output;
}
