import { NextResponse } from "next/server";
import {
  PIXEL_NFT_CONTRACT_ADDRESS,
  PIXEL_MARKETPLACE_ADDRESS,
  getUserTokenIds,
  publicClient,
} from "@/lib/contract";
import { getPixelImageUrl } from "@/lib/pixelImage";
import { MarketplaceAbi } from "@/lib/marketplaceAbi";
import { PixelNFTABI } from "@/lib/abi";
import { PixelV2ABI } from "@/lib/pixelV2Abi";
import {
  fetchUserNftsFromSubgraph,
  hasMarketplaceSubgraph,
} from "@/lib/marketplaceSubgraph";
import { createBoundedCache } from "@/lib/boundedCache";
import { publicErrorMessage } from "@/lib/server/publicError";
import { PIXEL_COLLECTIONS, isPixelV2Collection } from "@/lib/pixelCollections";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

const CACHE_TTL = 3_000;
const CACHE_MAX_ENTRIES = 1024;
const MAX_SUBGRAPH_BLOCK_LAG = 128n;
// Viem batches by calldata bytes, which do not account for large art returned
// by these getters. Bound the token count too, including the 256 x 256 grids.
const NFT_DETAILS_BATCH_SIZE = 20;
const nftCache = createBoundedCache<NativeNft[]>({
  maxEntries: CACHE_MAX_ENTRIES,
  ttlMs: CACHE_TTL,
  maxInFlight: CACHE_MAX_ENTRIES,
});

export interface NativeNft {
  collection: `0x${string}`;
  tokenId: string;
  name: string;
  imageUrl: string;
  listing: { listingId: string; price: string } | null;
}

async function fetchNativeNfts(address: string, force = false): Promise<NativeNft[]> {
  if (!force) return nftCache.load(address, () => loadNativeNfts(address, false));

  // A forced reload must read past the subgraph's own response cache, so it neither
  // uses the cached entry nor joins a non-forced load. It still coalesces with other
  // forced reloads (a key that is never retained) and then seeds the shared entry.
  const tokens = await nftCache.refresh(`force:${address}`, () => loadNativeNfts(address, true), 0);
  nftCache.set(address, tokens);
  return tokens;
}

async function loadNativeNfts(address: string, fresh: boolean): Promise<NativeNft[]> {
  const inventories = await Promise.all(PIXEL_COLLECTIONS.map((entry) => loadCollectionNfts(address, fresh, entry.address)));
  return inventories.flat();
}

async function loadCollectionNfts(address: string, fresh: boolean, collection: `0x${string}`): Promise<NativeNft[]> {
  // The existing published index covers V1. V2 must read RPC until a new index is published.
  if (collection.toLowerCase() === PIXEL_NFT_CONTRACT_ADDRESS.toLowerCase() && hasMarketplaceSubgraph()) {
    try {
      const payload = await fetchUserNftsFromSubgraph(address, 5_000, fresh);
      if (await isSubgraphFresh(payload)) {
        return payload.tokens.map((token) => ({ ...token, collection }));
      }
      console.warn(
        `[user-nfts] subgraph is stale at block ${payload.indexedBlock ?? "unknown"}; using RPC`
      );
    } catch (err) {
      console.warn("[user-nfts] subgraph fallback to RPC:", err);
    }
  }

  // Get token IDs first
  const tokenIds = await getUserTokenIds(address, collection, fresh);
  if (tokenIds.length === 0) {
    return [];
  }

  const tokens: NativeNft[] = [];
  const packedV2 = isPixelV2Collection(collection);
  for (let offset = 0; offset < tokenIds.length; offset += NFT_DETAILS_BATCH_SIZE) {
    const batch = tokenIds.slice(offset, offset + NFT_DETAILS_BATCH_SIZE);
    // Read the packed V2 getter directly: tokenData converts binary art to a
    // legacy hex string on-chain and is needlessly expensive for wallet lists.
    const [tokenDataResults, listingResults] = await Promise.all([
      publicClient.multicall({
        allowFailure: true,
        contracts: batch.map((tokenId) => packedV2 ? {
          address: collection,
          abi: PixelV2ABI,
          functionName: "tokenPackedData" as const,
          args: [tokenId] as const,
        } : {
          address: collection,
          abi: PixelNFTABI,
          functionName: "tokenData" as const,
          args: [tokenId] as const,
        }),
      }),
      // Listing reads share the same bounded batch and retain token order.
      publicClient.multicall({
        allowFailure: true,
        contracts: batch.map((n) => ({
          address: PIXEL_MARKETPLACE_ADDRESS,
          abi: MarketplaceAbi,
          functionName: "getListingByToken" as const,
          args: [collection, n] as const,
        })),
      }),
    ]);

    tokens.push(...batch.map((tokenId, i): NativeNft => {
      const tokenResult = tokenDataResults[i];
      const legacy = tokenResult?.status === "success"
        ? tokenResult.result as readonly [string, bigint, string, string, bigint, string] : null;
      const packed = tokenResult?.status === "success"
        ? tokenResult.result as readonly [string, string, bigint, string, string, bigint, string] : null;
      const name = packedV2 ? packed?.[0] : legacy?.[0];
      const grid = packedV2 ? packed?.[2] : legacy?.[1];
      const pixels = packedV2 ? packed?.[3] : legacy?.[2];
      let listing: NativeNft["listing"] = null;

      const r = listingResults[i];
      if (r?.status === "success" && r.result) {
        const [listingId, listingData] = r.result as readonly [bigint, {
          collection: `0x${string}`;
          tokenId: bigint;
          price: bigint;
          seller: `0x${string}`;
          active: boolean;
        }];
        if (listingId !== 0n && listingData.active) {
          listing = {
            listingId: listingId.toString(),
            price: listingData.price.toString(),
          };
        }
      }

      return {
        collection,
        tokenId: tokenId.toString(),
        name: name ?? "Untitled",
        imageUrl: pixels && grid
          ? getPixelImageUrl(tokenId, collection)
          : "",
        listing,
      };
    }));
  }

  return tokens;
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const address = searchParams.get("address");
  const force = searchParams.get("force") === "1";
  const responseHeaders = {
    "Cache-Control": force
      ? "private, no-store, max-age=0, must-revalidate"
      : "public, max-age=0, s-maxage=3, stale-while-revalidate=12",
  };
  if (!address || !/^0x[0-9a-fA-F]{40}$/.test(address)) {
    return NextResponse.json({ error: "Invalid address" }, { status: 400 });
  }
  try {
    const tokens = await fetchNativeNfts(address.toLowerCase(), force);
    return NextResponse.json(
      { tokens, count: tokens.length },
      { headers: responseHeaders },
    );
  } catch (err) {
    console.error("[user-nfts] request failed:", err);
    return NextResponse.json(
      { error: publicErrorMessage(err, "NFT data is temporarily unavailable") },
      { status: 500, headers: { "Cache-Control": "no-store" } }
    );
  }
}

async function isSubgraphFresh(payload: {
  indexedBlock: number | null;
  hasIndexingErrors: boolean;
}): Promise<boolean> {
  if (payload.hasIndexingErrors || payload.indexedBlock === null) return false;
  try {
    const currentBlock = await withTimeout(
      publicClient.getBlockNumber(),
      2_500,
      "RPC head check timed out"
    );
    return BigInt(payload.indexedBlock) + MAX_SUBGRAPH_BLOCK_LAG >= currentBlock;
  } catch {
    return false;
  }
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string
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
