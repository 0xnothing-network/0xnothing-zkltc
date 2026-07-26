import { NextResponse, type NextRequest } from "next/server";

const LEGACY_PUMP_PATH = "/0xpump";
const CANONICAL_PUMP_PATH = "/0xPump";

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  if (pathname !== LEGACY_PUMP_PATH && !pathname.startsWith(`${LEGACY_PUMP_PATH}/`)) {
    return NextResponse.next();
  }

  const url = request.nextUrl.clone();
  url.pathname = `${CANONICAL_PUMP_PATH}${pathname.slice(LEGACY_PUMP_PATH.length)}`;
  return NextResponse.redirect(url, 308);
}

export const config = {
  matcher: ["/0xpump", "/0xpump/:path*"],
};
