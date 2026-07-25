import { NextResponse } from "next/server";
import { getPumpStats } from "@/features/pump/server/data";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const payload = await getPumpStats();
  return NextResponse.json(payload, {
    headers: { "Cache-Control": "public, s-maxage=10, stale-while-revalidate=20" },
  });
}
