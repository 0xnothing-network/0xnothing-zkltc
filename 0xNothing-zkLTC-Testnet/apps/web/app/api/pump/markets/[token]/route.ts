import { NextResponse } from "next/server";
import { getAddress } from "viem";
import { getPumpMarket } from "@/features/pump/server/data";
import { withPumpCache } from "@/features/pump/server/cache";
import { publicCdnCacheHeaders } from "@/lib/server/cdnCache";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  context: { params: Promise<{ token: string }> },
) {
  const { token: rawToken } = await context.params;
  let token;
  try {
    token = getAddress(rawToken);
  } catch {
    return NextResponse.json({ error: "Invalid token address" }, { status: 400 });
  }
  const payload = await withPumpCache(
    `market:${token.toLowerCase()}`,
    () => getPumpMarket(token),
    { ttlMs: 2_000, staleMs: 8_000 },
  );
  return NextResponse.json(payload, {
    headers: publicCdnCacheHeaders(
      "public, s-maxage=2, stale-while-revalidate=8",
      2,
      8,
    ),
  });
}
