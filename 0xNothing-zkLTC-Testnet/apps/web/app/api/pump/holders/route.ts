import { NextResponse } from "next/server";
import { getAddress, type Address } from "viem";
import { getPumpHolders } from "@/features/pump/server/data";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const rawToken = params.get("token");
  if (!rawToken) {
    return NextResponse.json({ error: "Token address is required" }, { status: 400 });
  }

  let token: Address;
  try {
    token = getAddress(rawToken);
  } catch {
    return NextResponse.json({ error: "Invalid token address" }, { status: 400 });
  }

  try {
    const payload = await getPumpHolders({
      token,
      limit: Number(params.get("limit") || 10),
    });
    return NextResponse.json(payload, {
      headers: { "Cache-Control": "public, s-maxage=10, stale-while-revalidate=20" },
    });
  } catch (error) {
    console.error("[pump/holders] holder load failed:", error);
    return NextResponse.json({ error: "Holder data is temporarily unavailable" }, { status: 503 });
  }
}
