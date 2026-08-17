import { NextResponse } from "next/server";
import { getAddress, type Address } from "viem";
import { getPumpTrades } from "@/features/pump/server/data";
import { withPumpCache } from "@/features/pump/server/cache";
import { boundedIntegerParam } from "@/features/pump/server/request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const rawToken = params.get("token");
  const rawTrader = params.get("trader");
  let token: Address | undefined;
  let trader: Address | undefined;
  if (rawToken) {
    try {
      token = getAddress(rawToken);
    } catch {
      return NextResponse.json({ error: "Invalid token address" }, { status: 400 });
    }
  }
  if (rawTrader) {
    try {
      trader = getAddress(rawTrader);
    } catch {
      return NextResponse.json({ error: "Invalid trader address" }, { status: 400 });
    }
  }
  const limit = boundedIntegerParam(params, "limit", 40, 1, 200);
  const skip = boundedIntegerParam(params, "skip", 0, 0, 10_000);
  if (limit === undefined || skip === undefined) {
    return NextResponse.json({ error: "Invalid pagination parameters" }, { status: 400 });
  }
  const key = `trades:${token?.toLowerCase() ?? "all"}:${trader?.toLowerCase() ?? "all"}:${limit}:${skip}`;
  const payload = await withPumpCache(
    key,
    () => getPumpTrades({ token, trader, limit, skip }),
    { ttlMs: 1_000, staleMs: 5_000 },
  );
  return NextResponse.json(payload, {
    headers: { "Cache-Control": "no-store" },
  });
}
