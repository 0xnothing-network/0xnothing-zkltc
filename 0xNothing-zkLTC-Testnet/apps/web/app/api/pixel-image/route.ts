import { unstable_cache } from "next/cache";
import { publicClient } from "@/lib/contract";
import { PixelNFTABI } from "@/lib/abi";
import { pixelDataToSVGMarkup } from "@/lib/gridParser";
import { normalizeUint256TokenId } from "@/lib/tokenId";
import { resolvePixelCollection } from "@/lib/pixelCollections";

export const runtime = "nodejs";
export const revalidate = 31_536_000;

const readPixelImage = unstable_cache(
  async (tokenId: string, collection: `0x${string}`) => {
    const tuple = await publicClient.readContract({
      address: collection,
      abi: PixelNFTABI,
      functionName: "tokenData",
      args: [BigInt(tokenId)],
    }) as readonly [string, bigint, string, `0x${string}`, bigint, string];

    const gridSize = Number(tuple[1]);
    if (!tuple[2] || !Number.isInteger(gridSize) || gridSize <= 0) return "";
    return pixelDataToSVGMarkup(tuple[2], gridSize);
  },
  ["pixel-image-v2-collection"],
  { revalidate: 31_536_000 },
);

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const collection = resolvePixelCollection(params.get("collection"));
  if (!collection) return Response.json({ error: "Unsupported collection" }, { status: 400, headers: { "Cache-Control": "no-store" } });
  const rawTokenId = params.get("tokenId")?.trim() ?? "";
  const tokenId = normalizeUint256TokenId(rawTokenId);
  if (!tokenId) {
    return Response.json(
      { error: "Invalid tokenId" },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }

  try {
    const svg = await readPixelImage(tokenId, collection);
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
    console.warn(`[pixel-image] token ${tokenId} unavailable:`, error);
    return Response.json(
      { error: "Pixel image unavailable" },
      { status: 404, headers: { "Cache-Control": "no-store" } },
    );
  }
}
