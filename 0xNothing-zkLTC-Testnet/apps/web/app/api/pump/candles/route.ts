import { NextResponse } from "next/server";
import { getAddress } from "viem";
import { getPumpCandles } from "@/features/pump/server/data";
import { withPumpCache } from "@/features/pump/server/cache";
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
  const limit = Number(params.get("limit") || PUMP_CANDLE_LIMITS[period]);
  const payload = await withPumpCache(
    `candles:${token.toLowerCase()}:${period}:${limit}`,
    () => getPumpCandles({ token, period, limit }),
    { ttlMs: 2_000, staleMs: 8_000 },
  );
  return NextResponse.json(payload, {
    headers: { "Cache-Control": "private, no-store, max-age=0, must-revalidate" },
  });
}
