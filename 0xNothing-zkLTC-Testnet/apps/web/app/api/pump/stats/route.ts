import { NextResponse } from "next/server";
import { getPumpStats } from "@/features/pump/server/data";
import { withPumpCache } from "@/features/pump/server/cache";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const payload = await withPumpCache(
    "stats",
    getPumpStats,
    { ttlMs: 3_000, staleMs: 12_000 },
  );
  return NextResponse.json(payload, {
    headers: { "Cache-Control": "private, no-store, max-age=0, must-revalidate" },
  });
}
