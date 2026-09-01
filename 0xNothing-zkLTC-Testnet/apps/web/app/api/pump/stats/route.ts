import { NextResponse } from "next/server";
import { getPumpStats } from "@/features/pump/server/data";
import { withPumpCache } from "@/features/pump/server/cache";
import { publicCdnCacheHeaders } from "@/lib/server/cdnCache";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const payload = await withPumpCache(
      "stats",
      getPumpStats,
      { ttlMs: 3_000, staleMs: 12_000 },
    );
    return NextResponse.json(payload, {
      headers: publicCdnCacheHeaders(
        "public, s-maxage=3, stale-while-revalidate=12",
        3,
        12,
      ),
    });
  } catch (error) {
    console.error("[pump/stats] stats load failed:", error);
    return NextResponse.json({ error: "Protocol totals are temporarily unavailable" }, { status: 503 });
  }
}
