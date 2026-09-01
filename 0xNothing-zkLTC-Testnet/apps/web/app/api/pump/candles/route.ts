import { NextResponse } from "next/server";
import { getAddress } from "viem";
import { getPumpCandles } from "@/features/pump/server/data";
import { withPumpCache } from "@/features/pump/server/cache";
import { boundedIntegerParam } from "@/features/pump/server/request";
import { publicCdnCacheHeaders } from "@/lib/server/cdnCache";
import {
  MAX_PUMP_CANDLE_LIMIT,
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
  const limit = boundedIntegerParam(
    params,
    "limit",
    PUMP_CANDLE_LIMITS[period],
    1,
    MAX_PUMP_CANDLE_LIMIT,
  );
  if (limit === undefined) {
    return NextResponse.json({ error: "Invalid limit parameter" }, { status: 400 });
  }
  try {
    const payload = await withPumpCache(
      `candles:${token.toLowerCase()}:${period}:${limit}`,
      () => getPumpCandles({ token, period, limit }),
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
    console.error("[pump/candles] candle load failed:", error);
    return NextResponse.json({ error: "Candle data is temporarily unavailable" }, { status: 503 });
  }
}
