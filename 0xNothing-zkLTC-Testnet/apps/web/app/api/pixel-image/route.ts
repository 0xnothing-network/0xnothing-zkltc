import { unstable_cache } from "next/cache";
import { publicClient, PIXEL_NFT_CONTRACT_ADDRESS } from "@/lib/contract";
import { PixelNFTABI } from "@/lib/abi";
import { pixelDataToSVGMarkup } from "@/lib/gridParser";

export const runtime = "nodejs";
export const revalidate = 31_536_000;

const readPixelImage = unstable_cache(
  async (tokenId: string) => {
    const tuple = await publicClient.readContract({
      address: PIXEL_NFT_CONTRACT_ADDRESS,
      abi: PixelNFTABI,
      functionName: "tokenData",
      args: [BigInt(tokenId)],
    }) as readonly [string, bigint, string, `0x${string}`, bigint, string];

    const gridSize = Number(tuple[1]);
    if (!tuple[2] || !Number.isInteger(gridSize) || gridSize <= 0) return "";
    return pixelDataToSVGMarkup(tuple[2], gridSize);
  },
  ["pixel-image-v1"],
  { revalidate: 31_536_000 },
);

export async function GET(request: Request) {
  const tokenId = new URL(request.url).searchParams.get("tokenId")?.trim() ?? "";
  if (!/^\d{1,78}$/.test(tokenId)) {
    return Response.json(
      { error: "Invalid tokenId" },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }

  try {
    const svg = await readPixelImage(tokenId);
    if (!svg) {
      return Response.json(
        { error: "Pixel image unavailable" },
        { status: 404, headers: { "Cache-Control": "no-store" } },
      );
    }
    return new Response(svg, {
      headers: {
        "Cache-Control": "public, max-age=31536000, immutable",
        "Content-Type": "image/svg+xml; charset=utf-8",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    return Response.json(
      { error: (error as Error).message || "Pixel image unavailable" },
      { status: 404, headers: { "Cache-Control": "no-store" } },
    );
  }
}
