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

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 30;

interface CacheEntry<T> {
  value: T;
  ts: number;
}
const CACHE = new Map<string, CacheEntry<NativeNft[]>>();
const CACHE_TTL = 30_000;
const CACHE_MAX_ENTRIES = 1024;
const MAX_SUBGRAPH_BLOCK_LAG = 20_000n;

function writeCache(address: string, value: NativeNft[]) {
  CACHE.delete(address);
  CACHE.set(address, { value, ts: Date.now() });
  while (CACHE.size > CACHE_MAX_ENTRIES) {
    const oldestKey = CACHE.keys().next().value;
    if (oldestKey === undefined) break;
    CACHE.delete(oldestKey);
  }
}

export interface NativeNft {
  tokenId: string;
  name: string;
  imageUrl: string;
  listing: { listingId: string; price: string } | null;
}

async function fetchNativeNfts(address: string, force = false): Promise<NativeNft[]> {
  const cached = CACHE.get(address);
  if (!force && cached && Date.now() - cached.ts < CACHE_TTL) {
    return cached.value;
  }

  if (hasMarketplaceSubgraph()) {
    try {
      const payload = await fetchUserNftsFromSubgraph(address);
      if (await isSubgraphFresh(payload)) {
        writeCache(address, payload.tokens);
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
    writeCache(address, []);
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

  writeCache(address, tokens);
  return tokens;
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const address = searchParams.get("address");
  const force = searchParams.get("force") === "1";
  const responseHeaders = {
    "Cache-Control": force
      ? "no-store"
      : "public, s-maxage=30, stale-while-revalidate=30",
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
    return true;
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
