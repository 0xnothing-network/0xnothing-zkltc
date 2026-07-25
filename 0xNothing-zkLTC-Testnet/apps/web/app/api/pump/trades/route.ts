import { NextResponse } from "next/server";
import { getAddress, type Address } from "viem";
import { getPumpTrades } from "@/features/pump/server/data";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const rawToken = params.get("token");
  let token: Address | undefined;
  if (rawToken) {
    try {
      token = getAddress(rawToken);
    } catch {
      return NextResponse.json({ error: "Invalid token address" }, { status: 400 });
    }
  }
  const payload = await getPumpTrades({
    token,
    limit: Number(params.get("limit") || 40),
    skip: Number(params.get("skip") || 0),
  });
  return NextResponse.json(payload, {
    headers: { "Cache-Control": "public, s-maxage=8, stale-while-revalidate=15" },
  });
}
