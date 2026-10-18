import { NextResponse } from "next/server";
import { getPumpStats } from "@/features/pump/server/data";
import { withPumpCache } from "@/features/pump/server/cache";
import { CDN_STALE_SECONDS, isFreshRead, publicCdnCacheHeaders } from "@/lib/server/cdnCache";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const fresh = isFreshRead(request);
  try {
    const payload = await withPumpCache(
      "stats",
      getPumpStats,
      { ttlMs: 3_000, staleMs: 12_000, fresh },
    );
    return NextResponse.json(payload, {
      headers: publicCdnCacheHeaders(
        "public, s-maxage=3, stale-while-revalidate=12",
        3,
        fresh ? 0 : CDN_STALE_SECONDS,
      ),
    });
  } catch (error) {
    console.error("[pump/stats] stats load failed:", error);
    return NextResponse.json({ error: "Protocol totals are temporarily unavailable" }, { status: 503 });
  }
}
