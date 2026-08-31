import { NextResponse, type NextRequest } from "next/server";
import { trustedProxyRequest } from "@/lib/server/clientIp";

const LEGACY_PUMP_PATH = "/0xpump";
const CANONICAL_PUMP_PATH = "/0xPump";
const HEALTH_PATH = "/api/health";

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // When configured, this makes the Cloudflare-injected secret an origin
  // boundary. Railway's direct public hostname remains usable only for its
  // health probe, so Cloudflare WAF/rate limits cannot be bypassed by changing
  // the Host URL. Leaving the variable empty preserves local and Vercel use.
  if (
    pathname !== HEALTH_PATH
    && !trustedProxyRequest(request, process.env.TRUSTED_PROXY_SHARED_SECRET)
  ) {
    return NextResponse.json(
      { error: "Direct origin access is not allowed." },
      { status: 403, headers: { "Cache-Control": "no-store" } },
    );
  }

  if (pathname !== LEGACY_PUMP_PATH && !pathname.startsWith(`${LEGACY_PUMP_PATH}/`)) {
    return NextResponse.next();
  }

  const url = request.nextUrl.clone();
  url.pathname = `${CANONICAL_PUMP_PATH}${pathname.slice(LEGACY_PUMP_PATH.length)}`;
  return NextResponse.redirect(url, 308);
}

export const config = {
  runtime: "nodejs",
};
