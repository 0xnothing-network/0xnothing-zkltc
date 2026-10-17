import { after, NextResponse } from "next/server";
import { logsClient, publicClient } from "@/lib/contract";
import { createBoundedCache } from "@/lib/boundedCache";
import { CDN_STALE_SECONDS, publicCdnCacheHeaders } from "@/lib/server/cdnCache";
import { NFT_NUSD_ADDRESS, NUSD_MARKETPLACE_ADDRESS, NUSD_SUBGRAPH_URL } from "@/lib/nusdMarketplaceConfig";
import { PIXEL_COLLECTIONS } from "@/lib/pixelCollections";
import deployment from "@/lib/nusdMarketplace.generated.json";
import { parseNusdActivityCursor, readNusdMarketActivity, type NusdActivityFilter, type NusdActivityPage } from "@/lib/nusdMarketplaceActivity";
import { readNusdActivityFromSubgraph } from "@/lib/nusdMarketplaceSubgraph";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

// Contract and block reads keep the batching client; parallel getLogs slices use the unbatched one.
const activityClient = { getChainId: publicClient.getChainId, getBlock: publicClient.getBlock, readContract: publicClient.readContract, getLogs: logsClient.getLogs };
const ACTIVITY_FRESH_MS = 5_000;
// Pages are kept this long so a visitor after a quiet spell (the home page asks on
// every view) is answered at once while the next page loads behind the response.
const ACTIVITY_RETAIN_MS = 5 * 60_000;
const activityCache = createBoundedCache<NusdActivityPage>({ maxEntries: 256, ttlMs: ACTIVITY_RETAIN_MS, maxInFlight: 32 });
// `force=1` is public: a forced read is reused for 2 s so repeating it cannot multiply upstream load.
const forcedActivityCache = createBoundedCache<NusdActivityPage>({ maxEntries: 256, ttlMs: 2_000, maxInFlight: 32 });
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
  // The NUSD subgraph serves complete history cheaply; the verified RPC scan remains
  // the fallback while it is syncing, lagging or failing.
  const subgraphUrl = process.env.PIXEL_NUSD_SUBGRAPH_URL?.trim() || NUSD_SUBGRAPH_URL;
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
    let payload: NusdActivityPage;
    const cached = force ? undefined : activityCache.entry(key);
    if (force) {
      payload = await forcedActivityCache.load(key, load);
      activityCache.set(key, payload);
    } else if (cached?.fresh) {
      if (cached.ageMs >= ACTIVITY_FRESH_MS) after(() => activityCache.refresh(key, load).then(() => undefined, () => undefined));
      payload = cached.value;
    } else {
      payload = await activityCache.refresh(key, load);
    }
    return NextResponse.json(payload, { headers: force ? { "Cache-Control": "private, no-store" } : publicCdnCacheHeaders("public, max-age=0, s-maxage=5, stale-while-revalidate=5", 5, CDN_STALE_SECONDS) });
  } catch {
    return NextResponse.json({ error: "NUSD marketplace activity is unavailable" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
