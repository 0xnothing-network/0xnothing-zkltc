import { NextResponse } from "next/server";
import { PixelNFTABI } from "@/lib/abi";
import { publicClient } from "@/lib/contract";
import { getPixelImageUrl } from "@/lib/pixelImage";
import { resolvePixelCollection } from "@/lib/pixelCollections";
import { normalizeUint256TokenId } from "@/lib/tokenId";
import { publicCdnCacheHeaders } from "@/lib/server/cdnCache";

export const runtime = "nodejs";
export const revalidate = 60;

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const collection = resolvePixelCollection(searchParams.get("collection"));
  if (!collection) return NextResponse.json({ error: "Unsupported collection" }, { status: 400 });
  const raw = searchParams.get("tokenId");
  const tokenId = raw ? normalizeUint256TokenId(raw) : undefined;
  if (!tokenId) {
    return NextResponse.json({ error: "Invalid tokenId" }, { status: 400 });
  }
  let imageUrl = "";
  try {
    const tokenData = await publicClient.readContract({
      address: collection,
      abi: PixelNFTABI,
      functionName: "tokenData",
      args: [BigInt(tokenId)],
    }) as readonly [string, bigint, string, `0x${string}`, bigint, string];
    if (tokenData[2]) imageUrl = getPixelImageUrl(tokenId, collection);
  } catch {
    // Preserve the legacy endpoint contract for missing token IDs.
  }

  return NextResponse.json(
    { tokenId, imageUrl },
    {
      headers: imageUrl
        ? publicCdnCacheHeaders(
            "public, s-maxage=31536000, stale-while-revalidate=86400",
            31_536_000,
            86_400,
          )
        : publicCdnCacheHeaders(
            "public, s-maxage=60, stale-while-revalidate=60",
            60,
            60,
          ),
    },
  );
}
