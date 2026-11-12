import { NextResponse } from "next/server";
import {
  getUserTokenIds,
  publicClient,
} from "@/lib/contract";
import { getPixelImageUrl } from "@/lib/pixelImage";
import { readNusdWalletListings } from "@/lib/nusdMarketplaceInventory";
import { NFT_NUSD_ADDRESS, NUSD_MARKETPLACE_ADDRESS } from "@/lib/nusdMarketplaceConfig";
import { PixelClassicABI } from "@/lib/abi";
import { PixelNFTABI } from "@/lib/pixelNftAbi";
import { createBoundedCache } from "@/lib/boundedCache";
import { publicErrorMessage } from "@/lib/server/publicError";
import { PIXEL_COLLECTIONS, isPackedPixelCollection } from "@/lib/pixelCollections";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

const CACHE_TTL = 3_000;
const CACHE_MAX_ENTRIES = 1024;
// Viem batches by calldata bytes, which do not account for large art returned
// by these getters. Bound the token count too, including the 256 x 256 grids.
const NFT_DETAILS_BATCH_SIZE = 20;
// Any address can be asked for, and each token costs a full art read.
// shortcut: a holder past 1,000 per collection sees the first 1,000; page the
// route if a real wallet gets there.
const MAX_TOKENS_PER_COLLECTION = 1_000;
const nftCache = createBoundedCache<NativeNft[]>({
  maxEntries: CACHE_MAX_ENTRIES,
  ttlMs: CACHE_TTL,
  maxInFlight: CACHE_MAX_ENTRIES,
});
// A token's name and art are fixed at mint, so they are read from the chain once
// and not again on every 3-second poll of the wallet that holds it.
const TOKEN_DETAIL_TTL = 10 * 60_000;
const tokenDetailCache = createBoundedCache<{ name: string; hasImage: boolean }>({
  maxEntries: 4_096,
  ttlMs: TOKEN_DETAIL_TTL,
});
// `force=1` is public, so a forced read is shared for this long: callers still see
// the chain after their own transaction, while repeating it cannot multiply RPC load.
const FORCED_REUSE_MS = 2_000;
const forcedNftCache = createBoundedCache<NativeNft[]>({
  maxEntries: CACHE_MAX_ENTRIES,
  ttlMs: FORCED_REUSE_MS,
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

  // A forced reload reads past the token-id cache, so it never answers from a
  // non-forced entry. It joins or reuses the last forced read of the past two
  // seconds, then seeds the shared entry.
  const tokens = await forcedNftCache.load(address, () => loadNativeNfts(address, true));
  nftCache.set(address, tokens);
  return tokens;
}

async function loadNativeNfts(address: string, fresh: boolean): Promise<NativeNft[]> {
  const inventories = await Promise.all(PIXEL_COLLECTIONS.map((entry) => loadCollectionNfts(address, fresh, entry.address)));
  const tokens = inventories.flat().map((token) => ({ ...token, listing: null }));
  if (!NUSD_MARKETPLACE_ADDRESS) return tokens;
  const listings = await readNusdWalletListings(publicClient, NUSD_MARKETPLACE_ADDRESS, NFT_NUSD_ADDRESS, tokens, address as `0x${string}`);
  return tokens.map((token) => ({ ...token, listing: listings[`${token.collection.toLowerCase()}:${token.tokenId}`] ?? null }));
}

async function loadCollectionNfts(address: string, fresh: boolean, collection: `0x${string}`): Promise<NativeNft[]> {
  // Get token IDs first
  const tokenIds = await getUserTokenIds(address, collection, fresh, MAX_TOKENS_PER_COLLECTION);
  if (tokenIds.length === 0) {
    return [];
  }

  const detailKey = (tokenId: bigint) => `${collection.toLowerCase()}:${tokenId}`;
  const details = new Map<bigint, { name: string; hasImage: boolean }>();
  const unread: bigint[] = [];
  for (const tokenId of tokenIds) {
    const known = tokenDetailCache.get(detailKey(tokenId));
    if (known) details.set(tokenId, known);
    else unread.push(tokenId);
  }
  const isPacked = isPackedPixelCollection(collection);
  for (let offset = 0; offset < unread.length; offset += NFT_DETAILS_BATCH_SIZE) {
    const batch = unread.slice(offset, offset + NFT_DETAILS_BATCH_SIZE);
    // Read the packed getter directly: tokenData converts binary art to a
    // hex string on-chain and is needlessly expensive for wallet lists.
    const tokenDataResults = await publicClient.multicall({
      allowFailure: true,
      contracts: batch.map((tokenId) => isPacked ? {
        address: collection,
        abi: PixelNFTABI,
        functionName: "tokenPackedData" as const,
        args: [tokenId] as const,
      } : {
        address: collection,
        abi: PixelClassicABI,
        functionName: "tokenData" as const,
        args: [tokenId] as const,
      }),
    });

    batch.forEach((tokenId, i) => {
      const tokenResult = tokenDataResults[i];
      const classic = tokenResult?.status === "success"
        ? tokenResult.result as readonly [string, bigint, string, string, bigint, string] : null;
      const packed = tokenResult?.status === "success"
        ? tokenResult.result as readonly [string, string, bigint, string, string, bigint, string] : null;
      const name = isPacked ? packed?.[0] : classic?.[0];
      const grid = isPacked ? packed?.[2] : classic?.[1];
      const pixels = isPacked ? packed?.[3] : classic?.[2];
      const detail = { name: name ?? "Untitled", hasImage: Boolean(pixels && grid) };
      details.set(tokenId, detail);
      // A failed read is shown as a placeholder for this response only.
      if (tokenResult?.status === "success") tokenDetailCache.set(detailKey(tokenId), detail);
    });
  }

  return tokenIds.map((tokenId): NativeNft => {
    const detail = details.get(tokenId);
    return {
      collection,
      tokenId: tokenId.toString(),
      name: detail?.name ?? "Untitled",
      imageUrl: detail?.hasImage ? getPixelImageUrl(tokenId, collection) : "",
      listing: null,
    };
  });
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
    // The last list read for this wallet beats an error on a poll. A forced read
    // follows the caller's own transaction, so it must not be answered with it.
    const last = force ? undefined : nftCache.entry(address.toLowerCase());
    if (last) {
      return NextResponse.json(
        { tokens: last.value, count: last.value.length },
        { headers: { "Cache-Control": "no-store" } },
      );
    }
    return NextResponse.json(
      { error: publicErrorMessage(err, "NFT data is temporarily unavailable") },
      { status: 500, headers: { "Cache-Control": "no-store" } }
    );
  }
}


