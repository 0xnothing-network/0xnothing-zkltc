import { NextResponse } from "next/server";
import { getAddress } from "viem";
import { getPumpCandles } from "@/features/pump/server/data";
import {
  normalizePumpCandlePeriod,
  PUMP_CANDLE_LIMITS,
} from "@/features/pump/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  let token;
  try {
    token = getAddress(params.get("token") || "");
  } catch {
    return NextResponse.json({ error: "Invalid token address" }, { status: 400 });
  }
  const period = normalizePumpCandlePeriod(Number(params.get("period") || 3600));
  const payload = await getPumpCandles({
    token,
    period,
    limit: Number(params.get("limit") || PUMP_CANDLE_LIMITS[period]),
  });
  return NextResponse.json(payload, {
    headers: { "Cache-Control": "public, s-maxage=8, stale-while-revalidate=15" },
  });
}
