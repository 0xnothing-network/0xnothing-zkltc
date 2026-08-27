import { NextResponse } from "next/server";
import { PixelNFTABI } from "@/lib/abi";
import { PIXEL_NFT_CONTRACT_ADDRESS, publicClient } from "@/lib/contract";
import { getPixelImageUrl } from "@/lib/pixelImage";
import { normalizeUint256TokenId } from "@/lib/tokenId";

export const runtime = "nodejs";
export const revalidate = 60;

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const raw = searchParams.get("tokenId");
  const tokenId = raw ? normalizeUint256TokenId(raw) : undefined;
  if (!tokenId) {
    return NextResponse.json({ error: "Invalid tokenId" }, { status: 400 });
  }
  let imageUrl = "";
  try {
    const tokenData = await publicClient.readContract({
      address: PIXEL_NFT_CONTRACT_ADDRESS,
      abi: PixelNFTABI,
      functionName: "tokenData",
      args: [BigInt(tokenId)],
    }) as readonly [string, bigint, string, `0x${string}`, bigint, string];
    if (tokenData[2]) imageUrl = getPixelImageUrl(tokenId);
  } catch {
    // Preserve the legacy endpoint contract for missing token IDs.
  }

  return NextResponse.json(
    { tokenId, imageUrl },
    {
      headers: {
        "Cache-Control": imageUrl
          ? "public, s-maxage=31536000, stale-while-revalidate=86400"
          : "public, s-maxage=60, stale-while-revalidate=60",
      },
    },
  );
}
