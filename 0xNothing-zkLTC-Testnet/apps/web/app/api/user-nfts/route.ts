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
import {
  fetchUserNftsFromSubgraph,
  hasMarketplaceSubgraph,
} from "@/lib/marketplaceSubgraph";
import { createBoundedCache } from "@/lib/boundedCache";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

const CACHE_TTL = 3_000;
const CACHE_MAX_ENTRIES = 1024;
const MAX_SUBGRAPH_BLOCK_LAG = 128n;
const nftCache = createBoundedCache<NativeNft[]>({
  maxEntries: CACHE_MAX_ENTRIES,
  ttlMs: CACHE_TTL,
  maxInFlight: CACHE_MAX_ENTRIES,
});

export interface NativeNft {
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
  if (hasMarketplaceSubgraph()) {
    try {
      const payload = await fetchUserNftsFromSubgraph(address, 5_000, fresh);
      if (await isSubgraphFresh(payload)) {
        return payload.tokens;
      }
      console.warn(
        `[user-nfts] subgraph is stale at block ${payload.indexedBlock ?? "unknown"}; using RPC`
      );
    } catch (err) {
      console.warn("[user-nfts] subgraph fallback to RPC:", err);
    }
  }

  // Get token IDs first
  const tokenIds = await getUserTokenIds(address);
  if (tokenIds.length === 0) {
    return [];
  }

  // Fetch token data and listing data in parallel for maximum speed
  const [tokenDataResults, listingResults] = await Promise.all([
    publicClient.multicall({
      allowFailure: true,
      contracts: tokenIds.map((tokenId) => ({
        address: PIXEL_NFT_CONTRACT_ADDRESS,
        abi: PixelNFTABI,
        functionName: "tokenData" as const,
        args: [tokenId] as const,
      })),
    }),
    // All listing data in single multicall
    publicClient.multicall({
      allowFailure: true,
      contracts: tokenIds.map((n) => ({
        address: PIXEL_MARKETPLACE_ADDRESS,
        abi: MarketplaceAbi,
        functionName: "getListingByToken" as const,
        args: [PIXEL_NFT_CONTRACT_ADDRESS, n] as const,
      })),
    }),
  ]);

  const tokens: NativeNft[] = tokenIds.map((tokenId, i) => {
    const tokenResult = tokenDataResults[i];
    const data = tokenResult?.status === "success"
      ? tokenResult.result as readonly [string, bigint, string, string, bigint, string]
      : null;
    let listing: NativeNft["listing"] = null;

    const r = listingResults[i];
    if (r.status === "success" && r.result) {
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
      tokenId: tokenId.toString(),
      name: data?.[0] ?? "Untitled",
      imageUrl: data?.[2] && data?.[1]
        ? getPixelImageUrl(tokenId)
        : "",
      listing,
    };
  });

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
    return NextResponse.json(
      { error: (err as Error).message || "Unknown error" },
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
