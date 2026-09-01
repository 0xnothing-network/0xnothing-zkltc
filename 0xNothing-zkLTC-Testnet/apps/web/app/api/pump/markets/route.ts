import { NextResponse } from "next/server";
import { getAddress, type Address } from "viem";
import { getPumpMarkets } from "@/features/pump/server/data";
import { withPumpCache } from "@/features/pump/server/cache";
import { boundedIntegerParam } from "@/features/pump/server/request";
import type { PumpMarketSort } from "@/features/pump/types";
import { publicCdnCacheHeaders } from "@/lib/server/cdnCache";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const rawCreator = params.get("creator");
  const rawSort = params.get("sort");
  const sort: PumpMarketSort =
    rawSort === "VOLUME" || rawSort === "LAST_TRADE" ? rawSort : "NEWEST";
  let creator: Address | undefined;
  if (rawCreator) {
    try {
      creator = getAddress(rawCreator);
    } catch {
      return NextResponse.json({ error: "Invalid creator address" }, { status: 400 });
    }
  }
  const limit = boundedIntegerParam(params, "limit", 60, 1, 200);
  // Matches the /pump/trades bound. A deeper skip cannot be reached by paging
  // through 60-row pages, and every distinct value mints its own cache key.
  const skip = boundedIntegerParam(params, "skip", 0, 0, 10_000);
  if (limit === undefined || skip === undefined) {
    return NextResponse.json({ error: "Invalid pagination parameters" }, { status: 400 });
  }
  const key = `markets:${creator?.toLowerCase() ?? "all"}:${limit}:${skip}:${sort}`;
  try {
    const payload = await withPumpCache(
      key,
      () => getPumpMarkets({ limit, skip, creator, sort }),
      { ttlMs: 2_000, staleMs: 8_000 },
    );
    return NextResponse.json(payload, {
      headers: publicCdnCacheHeaders(
        "public, s-maxage=2, stale-while-revalidate=8",
        2,
        8,
      ),
    });
  } catch (error) {
    // Subgraph and RPC failure text names internal hosts and status codes; only
    // the curated line goes out, as on /pump/holders.
    console.error("[pump/markets] market load failed:", error);
    return NextResponse.json({ error: "Market data is temporarily unavailable" }, { status: 503 });
  }
}
