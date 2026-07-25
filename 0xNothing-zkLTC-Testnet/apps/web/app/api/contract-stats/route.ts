import { NextResponse } from "next/server";
import { PixelNFTABI } from "@/lib/abi";
import { PIXEL_NFT_CONTRACT_ADDRESS, publicClient } from "@/lib/contract";

export const runtime = "nodejs";
export const revalidate = 30;

export async function GET() {
  try {
    const [name, symbol, maxGrid] = await Promise.all([
      publicClient.readContract({
        address: PIXEL_NFT_CONTRACT_ADDRESS,
        abi: PixelNFTABI,
        functionName: "name",
      }),
      publicClient.readContract({
        address: PIXEL_NFT_CONTRACT_ADDRESS,
        abi: PixelNFTABI,
        functionName: "symbol",
      }),
      publicClient.readContract({
        address: PIXEL_NFT_CONTRACT_ADDRESS,
        abi: PixelNFTABI,
        functionName: "MAX_GRID",
      }),
    ]);

    return NextResponse.json({
      contract: PIXEL_NFT_CONTRACT_ADDRESS,
      name,
      symbol,
      maxGrid: (maxGrid as bigint).toString(),
    });
  } catch (err) {
    console.error("[contract-stats] error:", err);
    return NextResponse.json(
      { error: "Failed to read contract" },
      { status: 500 }
    );
  }
}
