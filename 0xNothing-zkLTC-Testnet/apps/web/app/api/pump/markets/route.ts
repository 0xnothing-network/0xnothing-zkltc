import { NextResponse } from "next/server";
import { getAddress, type Address } from "viem";
import { getPumpMarkets } from "@/features/pump/server/data";
import type { PumpMarketSort } from "@/features/pump/types";

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
  const payload = await getPumpMarkets({
    limit: Number(params.get("limit") || 60),
    skip: Number(params.get("skip") || 0),
    creator,
    sort,
  });
  return NextResponse.json(payload, {
    headers: { "Cache-Control": "private, no-store, max-age=0, must-revalidate" },
  });
}
