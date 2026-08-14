import { NextResponse } from "next/server";
import { getAddress } from "viem";
import { getPumpMarket } from "@/features/pump/server/data";

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
  const payload = await getPumpMarket(token);
  return NextResponse.json(payload, {
    status: payload.configured && !payload.market ? 404 : 200,
    headers: { "Cache-Control": "private, no-store, max-age=0, must-revalidate" },
  });
}
