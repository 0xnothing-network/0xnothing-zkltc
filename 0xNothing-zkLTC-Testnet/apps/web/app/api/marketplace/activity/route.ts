import { NextResponse } from "next/server";
import { logsClient, publicClient } from "@/lib/contract";
import { createBoundedCache } from "@/lib/boundedCache";
import { publicCdnCacheHeaders } from "@/lib/server/cdnCache";
import { NFT_NUSD_ADDRESS, NUSD_MARKETPLACE_ADDRESS } from "@/lib/nusdMarketplaceConfig";
import { PIXEL_COLLECTIONS } from "@/lib/pixelCollections";
import deployment from "@/lib/nusdMarketplace.generated.json";
import { parseNusdActivityCursor, readNusdMarketActivity, type NusdActivityFilter, type NusdActivityPage } from "@/lib/nusdMarketplaceActivity";
import { readNusdActivityFromSubgraph } from "@/lib/nusdMarketplaceSubgraph";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

// Contract and block reads keep the batching client; parallel getLogs slices use the unbatched one.
const activityClient = { getChainId: publicClient.getChainId, getBlock: publicClient.getBlock, readContract: publicClient.readContract, getLogs: logsClient.getLogs };
const activityCache = createBoundedCache<NusdActivityPage>({ maxEntries: 256, ttlMs: 5_000, maxInFlight: 32 });
const filters = new Set<NusdActivityFilter>(["ALL", "BOUGHT", "MINTED", "LISTED", "CANCELLED", "OFFERS"]);

export async function GET(request: Request) {
  if (!NUSD_MARKETPLACE_ADDRESS) return NextResponse.json({ error: "NUSD marketplace is not configured" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  const params = new URL(request.url).searchParams;
  const filter = (params.get("type") ?? "ALL").toUpperCase() as NusdActivityFilter;
  const cursor = params.get("cursor");
  const rawLimit = params.get("limit") ?? "24";
  if (!filters.has(filter) || !/^\d{1,3}$/.test(rawLimit) || Number(rawLimit) < 1 || Number(rawLimit) > 100) return NextResponse.json({ error: "Invalid activity filter or limit" }, { status: 400 });
  try { parseNusdActivityCursor(cursor); }
  catch { return NextResponse.json({ error: "Invalid activity cursor" }, { status: 400 }); }
  const force = params.get("force") === "1";
  const key = `${NUSD_MARKETPLACE_ADDRESS}:${filter}:${cursor ?? "latest"}:${rawLimit}`;
  // The NUSD subgraph (server-only PIXEL_NUSD_SUBGRAPH_URL) serves complete history
  // cheaply; the verified RPC scan remains the fallback when it is unset, lagging or failing.
  const subgraphUrl = process.env.PIXEL_NUSD_SUBGRAPH_URL?.trim();
  const load = async () => {
    if (subgraphUrl) {
      try {
        const latestBlock = cursor ? undefined : await publicClient.getBlockNumber();
        return await readNusdActivityFromSubgraph(subgraphUrl, { filter, cursor, limit: Number(rawLimit), latestBlock });
      } catch (error) {
        console.warn("[marketplace] NUSD subgraph unavailable; using RPC:", error instanceof Error ? error.message : error);
      }
    }
    return readNusdMarketActivity(activityClient, {
      market: NUSD_MARKETPLACE_ADDRESS!,
      nusd: NFT_NUSD_ADDRESS,
      collections: PIXEL_COLLECTIONS.map((entry) => entry.address),
      deploymentBlock: deployment.address.toLowerCase() === NUSD_MARKETPLACE_ADDRESS!.toLowerCase() ? BigInt(deployment.deploymentBlock) : 0n,
      cursor, filter, limit: Number(rawLimit),
    });
  };
  try {
    const payload = force ? await activityCache.refresh(`force:${key}`, load, 0) : await activityCache.load(key, load);
    if (force) activityCache.set(key, payload);
    return NextResponse.json(payload, { headers: force ? { "Cache-Control": "private, no-store" } : publicCdnCacheHeaders("public, max-age=0, s-maxage=5, stale-while-revalidate=5", 5, 5) });
  } catch {
    return NextResponse.json({ error: "NUSD marketplace activity is unavailable" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
