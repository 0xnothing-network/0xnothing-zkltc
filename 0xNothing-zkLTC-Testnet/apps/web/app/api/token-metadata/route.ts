import { NextResponse } from "next/server";
import { publicClient, PIXEL_NFT_CONTRACT_ADDRESS } from "@/lib/contract";
import { PixelNFTABI } from "@/lib/abi";
import { getPixelImageUrl } from "@/lib/pixelImage";
import {
  fetchTokenMetadataFromSubgraph,
  hasMarketplaceSubgraph,
} from "@/lib/marketplaceSubgraph";

export const runtime = "nodejs";
export const revalidate = 30;

interface CacheEntry<T> {
  value: T;
  ts: number;
  error?: boolean;
}
const CACHE = new Map<string, CacheEntry<TokenMetadata | null>>();
const CACHE_TTL = 30_000;
const CACHE_TTL_ERROR = 2_000;

interface TokenMetadata {
  tokenId: string;
  name: string;
  imageUrl: string;
  creator: string;
  mintedAt: number;
}

/**
 * Fetch display metadata for a set of token IDs in a single multicall.
 *
 * Pass tokenIds as a comma-separated `?ids=1,2,3` query string. Output is a
 * map keyed by tokenId (as string) so callers can resolve by id without
 * re-parsing an array. Missing/burned tokens map to `null` so the UI can
 * gracefully show "Token #N" as a fallback.
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const raw = searchParams.get("ids");
  if (!raw) {
    return NextResponse.json({ error: "Missing ids" }, { status: 400 });
  }

  const ids = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => /^\d+$/.test(s))
    .slice(0, 20); // safety cap

  if (ids.length === 0) {
    return NextResponse.json({ error: "No valid ids" }, { status: 400 });
  }

  // De-dupe while preserving order.
  const uniqueIds: string[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    if (!seen.has(id)) {
      seen.add(id);
      uniqueIds.push(id);
    }
  }

  try {
    const result = await fetchMetadataBatch(uniqueIds);
    return NextResponse.json(
      { tokens: result },
      {
        headers: {
          "Cache-Control": "public, s-maxage=30, stale-while-revalidate=30",
        },
      },
    );
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message || "Unknown error" },
      { status: 500, headers: { "Cache-Control": "no-store" } }
    );
  }
}

async function fetchMetadataBatch(
  tokenIds: string[]
): Promise<Record<string, TokenMetadata | null>> {
  // Hydrate from cache first.
  const out: Record<string, TokenMetadata | null> = {};
  const missing: string[] = [];
  for (const id of tokenIds) {
    const cached = CACHE.get(id);
    const ttl = cached?.error ? CACHE_TTL_ERROR : CACHE_TTL;
    if (cached && Date.now() - cached.ts < ttl) {
      out[id] = cached.value;
    } else {
      missing.push(id);
    }
  }

  if (missing.length === 0) return out;

  let rpcMissing = missing;
  if (hasMarketplaceSubgraph()) {
    try {
      const subgraphTokens = await fetchTokenMetadataFromSubgraph(missing);
      rpcMissing = [];

      for (const id of missing) {
        const meta = subgraphTokens[id] ?? null;
        if (meta?.imageUrl) {
          const next: TokenMetadata = {
            tokenId: meta.tokenId,
            name: meta.name || `Token #${id}`,
            imageUrl: meta.imageUrl,
            creator: meta.creator,
            mintedAt: meta.mintedAt,
          };
          CACHE.set(id, { value: next, ts: Date.now() });
          out[id] = next;
        } else {
          rpcMissing.push(id);
        }
      }
    } catch (err) {
      console.warn("[token-metadata] subgraph fallback to RPC:", err);
      rpcMissing = missing;
    }
  }

  if (rpcMissing.length === 0) return out;

  // Multicall tokenData for the rest. allowFailure so one missing token
  // doesn't poison the whole batch.
  const results = await publicClient.multicall({
    allowFailure: true,
    contracts: rpcMissing.map((id) => ({
      address: PIXEL_NFT_CONTRACT_ADDRESS,
      abi: PixelNFTABI,
      functionName: "tokenData" as const,
      args: [BigInt(id)] as const,
    })),
  });

  for (let i = 0; i < rpcMissing.length; i++) {
    const id = rpcMissing[i];
    const r = results[i];
    if (!r || r.status !== "success") {
      // Cache the miss briefly so we don't hammer a bad token id.
      CACHE.set(id, { value: null, ts: Date.now(), error: true });
      out[id] = null;
      continue;
    }
    const tuple = r.result as readonly [string, bigint, string, string, bigint, string];
    const [name, gridSize, pixelData, creator, mintedAt] = tuple;
    const imageUrl = pixelData && gridSize
      ? getPixelImageUrl(id)
      : "";
    const meta: TokenMetadata = {
      tokenId: id,
      name: name || `Token #${id}`,
      imageUrl,
      creator,
      mintedAt: Number(mintedAt),
    };
    CACHE.set(id, { value: meta, ts: Date.now() });
    out[id] = meta;
  }

  // Garbage-collect cache so it doesn't grow unbounded.
  if (CACHE.size > 4096) {
    const now = Date.now();
    for (const [k, v] of CACHE) {
      const ttl = v.error ? CACHE_TTL_ERROR : CACHE_TTL;
      if (now - v.ts > ttl) CACHE.delete(k);
    }
    while (CACHE.size > 4096) {
      const oldestKey = CACHE.keys().next().value;
      if (oldestKey === undefined) break;
      CACHE.delete(oldestKey);
    }
  }

  return out;
}
