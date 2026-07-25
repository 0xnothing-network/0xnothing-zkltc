import { NextResponse } from "next/server";
import {
  fetchMarketplaceActivityFromSubgraph,
  hasMarketplaceSubgraph,
  type SubgraphMarketEventDTO,
  type SubgraphMarketEventType,
} from "@/lib/marketplaceSubgraph";
import { fetchMarketplaceActivityFromOnchain } from "@/lib/onchainMarketplace";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 15;

interface CacheEntry {
  value: { events: SubgraphMarketEventDTO[] };
  ts: number;
}

const ACTIVITY_TTL = 15_000;
const ACTIVITY_CACHE_MAX_ENTRIES = 256;
const activityCache = new Map<string, CacheEntry>();

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const limit = clampNumber(searchParams.get("limit"), 1, 100, 30);
  const skip = clampNumber(searchParams.get("skip"), 0, 10_000, 0);
  const eventTypes = parseEventTypes(searchParams.get("type"));
  const force = searchParams.get("force") === "1";
  const responseHeaders = {
    "Cache-Control": force
      ? "no-store"
      : "public, s-maxage=15, stale-while-revalidate=15",
  };
  const cacheKey = `${limit}:${skip}:${eventTypes.join(",") || "all"}`;
  const cached = activityCache.get(cacheKey);

  if (!force && cached && Date.now() - cached.ts < ACTIVITY_TTL) {
    return NextResponse.json(cached.value, { headers: responseHeaders });
  }

  if (hasMarketplaceSubgraph()) {
    try {
      const payload = await fetchMarketplaceActivityFromSubgraph({
        limit,
        skip,
        eventTypes: eventTypes.length ? eventTypes : undefined,
      });
      const value = { events: payload.events };
      writeActivityCache(cacheKey, value);
      return NextResponse.json(value, { headers: responseHeaders });
    } catch (err) {
      console.warn("[marketplace] activity subgraph failed; using on-chain data:", err);
    }
  }

  try {
    const payload = await fetchMarketplaceActivityFromOnchain({
      limit,
      skip,
      eventTypes: eventTypes.length ? eventTypes : undefined,
    });
    writeActivityCache(cacheKey, payload);
    return NextResponse.json(payload, { headers: responseHeaders });
  } catch (err) {
    console.error("[marketplace] on-chain activity fallback failed:", err);
    if (cached) return NextResponse.json(cached.value, { headers: responseHeaders });
    return NextResponse.json(
      { error: "Marketplace activity is unavailable" },
      { status: 503, headers: { "Cache-Control": "no-store" } }
    );
  }
}

function writeActivityCache(key: string, value: CacheEntry["value"]) {
  activityCache.delete(key);
  activityCache.set(key, { value, ts: Date.now() });
  while (activityCache.size > ACTIVITY_CACHE_MAX_ENTRIES) {
    const oldestKey = activityCache.keys().next().value;
    if (oldestKey === undefined) break;
    activityCache.delete(oldestKey);
  }
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
