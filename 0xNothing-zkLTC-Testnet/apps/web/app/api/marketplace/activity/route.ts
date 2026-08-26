import { NextResponse } from "next/server";
import {
  fetchMarketplaceActivityFromSubgraph,
  hasMarketplaceSubgraph,
  type SubgraphMarketEventDTO,
  type SubgraphMarketEventType,
} from "@/lib/marketplaceSubgraph";
import { fetchMarketplaceActivityFromOnchain } from "@/lib/onchainMarketplace";
import { createBoundedCache } from "@/lib/boundedCache";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

type ActivityPayload = { events: SubgraphMarketEventDTO[] };

const ACTIVITY_TTL = 3_000;
const ACTIVITY_CACHE_MAX_ENTRIES = 256;
// Entries are kept until the entry cap evicts them, so freshness is derived from the
// entry age and the last successful payload stays available as a failure fallback.
const activityCache = createBoundedCache<ActivityPayload>({
  maxEntries: ACTIVITY_CACHE_MAX_ENTRIES,
  maxInFlight: ACTIVITY_CACHE_MAX_ENTRIES,
});

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const limit = clampNumber(searchParams.get("limit"), 1, 100, 30);
  const skip = clampNumber(searchParams.get("skip"), 0, 10_000, 0);
  const eventTypes = parseEventTypes(searchParams.get("type"));
  const force = searchParams.get("force") === "1";
  const responseHeaders = {
    "Cache-Control": force
      ? "private, no-store, max-age=0, must-revalidate"
      : "public, max-age=0, s-maxage=2, stale-while-revalidate=8",
  };
  const cacheKey = `${limit}:${skip}:${eventTypes.join(",") || "all"}`;
  const cached = activityCache.entry(cacheKey);

  if (!force && cached && cached.ageMs < ACTIVITY_TTL) {
    return NextResponse.json(cached.value, { headers: responseHeaders });
  }

  try {
    // A forced load skips Next's data cache, so it coalesces only with other forced
    // loads: a separate key with a zero ttl tracks that flight without retaining it,
    // and the result then seeds the shared entry.
    const payload = force
      ? await activityCache.refresh(`force:${cacheKey}`, () => loadMarketplaceActivity(limit, skip, eventTypes, true), 0)
      : await activityCache.refresh(cacheKey, () => loadMarketplaceActivity(limit, skip, eventTypes, false));
    if (force) activityCache.set(cacheKey, payload);
    return NextResponse.json(payload, { headers: responseHeaders });
  } catch (err) {
    console.error("[marketplace] on-chain activity fallback failed:", err);
    const stale = activityCache.entry(cacheKey);
    if (stale) return NextResponse.json(stale.value, { headers: responseHeaders });
    return NextResponse.json(
      { error: "Marketplace activity is unavailable" },
      { status: 503, headers: { "Cache-Control": "no-store" } }
    );
  }
}

async function loadMarketplaceActivity(
  limit: number,
  skip: number,
  eventTypes: SubgraphMarketEventType[],
  fresh: boolean,
): Promise<ActivityPayload> {
  if (hasMarketplaceSubgraph()) {
    try {
      const payload = await fetchMarketplaceActivityFromSubgraph({
        limit,
        skip,
        eventTypes: eventTypes.length ? eventTypes : undefined,
        fresh,
      });
      return { events: payload.events };
    } catch (err) {
      console.warn("[marketplace] activity subgraph failed; using on-chain data:", err);
    }
  }

  return fetchMarketplaceActivityFromOnchain({
    limit,
    skip,
    eventTypes: eventTypes.length ? eventTypes : undefined,
  });
}

function clampNumber(
  raw: string | null,
  min: number,
  max: number,
  fallback: number
): number {
  if (raw === null || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.floor(value), min), max);
}

function parseEventTypes(raw: string | null): SubgraphMarketEventType[] {
  if (!raw || raw === "all") return [];
  const values = raw.split(",").map((value) => value.trim().toUpperCase());
  return values.filter(isMarketEventType);
}

function isMarketEventType(value: string): value is SubgraphMarketEventType {
  return value === "MINTED" || value === "LISTED" || value === "BOUGHT" || value === "CANCELLED";
}
