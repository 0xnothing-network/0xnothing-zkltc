import { resolvePixelCollection, pixelTokenKey, isPixelV2Collection } from "@/lib/pixelCollections";
import { NextResponse } from "next/server";
import { publicClient } from "@/lib/contract";
import { PixelNFTABI } from "@/lib/abi";
import { PixelV2ABI } from "@/lib/pixelV2Abi";
import { getPixelImageUrl } from "@/lib/pixelImage";
import {
  fetchTokenMetadataFromSubgraph,
  hasMarketplaceSubgraph,
} from "@/lib/marketplaceSubgraph";
import { createBoundedCache } from "@/lib/boundedCache";
import { publicErrorMessage } from "@/lib/server/publicError";
import { normalizeUint256TokenId } from "@/lib/tokenId";
import { publicCdnCacheHeaders } from "@/lib/server/cdnCache";

export const runtime = "nodejs";
export const revalidate = 30;

const CACHE_TTL = 30_000;
const CACHE_TTL_ERROR = 2_000;
const MAX_CACHE_ENTRIES = 4_096;

interface TokenMetadata {
  tokenId: string;
  name: string;
  description?: string;
  imageUrl: string;
  creator: string;
  mintedAt: number;
}

// A null value is a token that could not be read; it is written with the shorter
// error ttl so a bad id is retried soon instead of being pinned for 30 seconds.
const metadataCache = createBoundedCache<TokenMetadata | null>({
  maxEntries: MAX_CACHE_ENTRIES,
  ttlMs: CACHE_TTL,
});

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
  const collection = resolvePixelCollection(searchParams.get("collection"));
  if (!collection) return NextResponse.json({ error: "Unsupported collection" }, { status: 400 });
  const raw = searchParams.get("ids");
  if (!raw) {
    return NextResponse.json({ error: "Missing ids" }, { status: 400 });
  }

  const ids = raw
    .split(",")
    .map((s) => s.trim())
    .map(normalizeUint256TokenId)
    .filter((id): id is string => Boolean(id));

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
      if (uniqueIds.length === 20) break; // safety cap after canonical de-duplication
    }
  }

  try {
    const result = await fetchMetadataBatch(uniqueIds, collection);
    return NextResponse.json(
      { tokens: result },
      {
        headers: publicCdnCacheHeaders(
          "public, s-maxage=30, stale-while-revalidate=30",
          30,
          30,
        ),
      },
    );
  } catch (err) {
    console.error("[token-metadata] request failed:", err);
    return NextResponse.json(
      { error: publicErrorMessage(err, "Token metadata is temporarily unavailable") },
      { status: 500, headers: { "Cache-Control": "no-store" } }
    );
  }
}

async function fetchMetadataBatch(
  tokenIds: string[], collection: `0x${string}`
): Promise<Record<string, TokenMetadata | null>> {
  // Hydrate from cache first.
  const out: Record<string, TokenMetadata | null> = {};
  const missing: string[] = [];
  for (const id of tokenIds) {
    const cached = metadataCache.get(pixelTokenKey(collection, id));
    if (cached !== undefined) {
      out[id] = cached;
    } else {
      missing.push(id);
    }
  }

  if (missing.length === 0) return out;

  let rpcMissing = missing;
  if (!isPixelV2Collection(collection) && hasMarketplaceSubgraph()) {
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
          metadataCache.set(pixelTokenKey(collection, id), next);
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

  // V2 returns the immutable description and binary art directly, avoiding
  // tokenURI's SVG/base64 rendering cost and tokenData's hex conversion.
  const packedV2 = isPixelV2Collection(collection);
  const results = await publicClient.multicall({
    allowFailure: true,
    contracts: rpcMissing.map((id) => packedV2 ? {
      address: collection,
      abi: PixelV2ABI,
      functionName: "tokenPackedData" as const,
      args: [BigInt(id)] as const,
    } : {
      address: collection,
      abi: PixelNFTABI,
      functionName: "tokenData" as const,
      args: [BigInt(id)] as const,
    }),
  });

  for (let i = 0; i < rpcMissing.length; i++) {
    const id = rpcMissing[i];
    const r = results[i];
    if (!r || r.status !== "success") {
      // Cache the miss briefly so we don't hammer a bad token id.
      metadataCache.set(pixelTokenKey(collection, id), null, CACHE_TTL_ERROR);
      out[id] = null;
      continue;
    }
    const legacy = r.result as readonly [string, bigint, string, string, bigint, string];
    const packed = r.result as readonly [string, string, bigint, string, string, bigint, string];
    const [name, gridSize, pixelData, creator, mintedAt] = packedV2
      ? [packed[0], packed[2], packed[3], packed[4], packed[5]] as const
      : legacy;
    const imageUrl = pixelData && gridSize
      ? getPixelImageUrl(id, collection)
      : "";
    const meta: TokenMetadata = {
      tokenId: id,
      name: name || `Token #${id}`,
      ...(packedV2 ? { description: packed[1] } : {}),
      imageUrl,
      creator,
      mintedAt: Number(mintedAt),
    };
    metadataCache.set(pixelTokenKey(collection, id), meta);
    out[id] = meta;
  }

  return out;
}
