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
const nftCache = createBoundedCache<NativeNft[]>({
  maxEntries: CACHE_MAX_ENTRIES,
  ttlMs: CACHE_TTL,
  maxInFlight: CACHE_MAX_ENTRIES,
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
  const tokenIds = await getUserTokenIds(address, collection, fresh);
  if (tokenIds.length === 0) {
    return [];
  }

  const tokens: NativeNft[] = [];
  const isPacked = isPackedPixelCollection(collection);
  for (let offset = 0; offset < tokenIds.length; offset += NFT_DETAILS_BATCH_SIZE) {
    const batch = tokenIds.slice(offset, offset + NFT_DETAILS_BATCH_SIZE);
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

    tokens.push(...batch.map((tokenId, i): NativeNft => {
      const tokenResult = tokenDataResults[i];
      const classic = tokenResult?.status === "success"
        ? tokenResult.result as readonly [string, bigint, string, string, bigint, string] : null;
      const packed = tokenResult?.status === "success"
        ? tokenResult.result as readonly [string, string, bigint, string, string, bigint, string] : null;
      const name = isPacked ? packed?.[0] : classic?.[0];
      const grid = isPacked ? packed?.[2] : classic?.[1];
      const pixels = isPacked ? packed?.[3] : classic?.[2];

      return {
        collection,
        tokenId: tokenId.toString(),
        name: name ?? "Untitled",
        imageUrl: pixels && grid
          ? getPixelImageUrl(tokenId, collection)
          : "",
        listing: null,
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


