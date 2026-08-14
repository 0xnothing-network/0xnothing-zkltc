import { NextResponse } from "next/server";
import { getPumpStats } from "@/features/pump/server/data";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const payload = await getPumpStats();
  return NextResponse.json(payload, {
    headers: { "Cache-Control": "private, no-store, max-age=0, must-revalidate" },
  });
}
