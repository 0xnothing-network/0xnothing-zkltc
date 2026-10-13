import { createSlidingWindowRateLimiter } from "./slidingWindowRateLimit.ts";
import { trustedProxyRequest } from "./proxyAuth.ts";

const READ_WINDOW_MS = 60_000;
const WRITE_WINDOW_MS = 60_000;
const MAX_READS = 180;
const MAX_IMAGES = 600;
const MAX_WRITES = 30;
const MAX_KEYS = 8_192;

const readLimiter = createSlidingWindowRateLimiter({
  windowMs: READ_WINDOW_MS,
  maxAttempts: MAX_READS,
  maxKeys: MAX_KEYS,
});
const imageLimiter = createSlidingWindowRateLimiter({
  windowMs: READ_WINDOW_MS,
  maxAttempts: MAX_IMAGES,
  maxKeys: MAX_KEYS,
});
const writeLimiter = createSlidingWindowRateLimiter({
  windowMs: WRITE_WINDOW_MS,
  maxAttempts: MAX_WRITES,
  maxKeys: MAX_KEYS,
});

const TRUSTED_PROXY_HEADER = "x-0xnothing-proxy-secret";
const CLOUDFLARE_IP_HEADER = "cf-connecting-ip";

function looksLikeIp(value: string): boolean {
  const candidate = value.trim().toLowerCase();
  if (!candidate || candidate.length > 64) return false;
  if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(candidate)) {
    return candidate.split(".").every((octet) => {
      if (octet.length > 1 && octet.startsWith("0")) return false;
      const n = Number(octet);
      return n >= 0 && n <= 255;
    });
  }
  return candidate.includes(":") && /^[0-9a-f:]+$/.test(candidate);
}

function normalizeIpToken(value: string | null): string | undefined {
  if (!value) return undefined;
  let candidate = value.trim().replace(/^"|"$/g, "");
  if (!candidate) return undefined;
  if (candidate.startsWith("[")) {
    const close = candidate.indexOf("]");
    if (close > 1) candidate = candidate.slice(1, close);
  } else if (!looksLikeIp(candidate)) {
    const separator = candidate.lastIndexOf(":");
    if (separator > 0) {
      const withoutPort = candidate.slice(0, separator);
      if (looksLikeIp(withoutPort)) candidate = withoutPort;
    }
  }
  return looksLikeIp(candidate) ? candidate.toLowerCase() : undefined;
}

function rightmostForwardedIp(value: string | null): string | undefined {
  if (!value) return undefined;
  const entries = value.split(",");
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const candidate = normalizeIpToken(entries[index]);
    if (candidate) return candidate;
  }
  return undefined;
}

/**
 * Edge-safe client identity for public API quotas. Spoofable forwarding
 * headers are ignored unless the trusted proxy secret is present, matching
 * the Node `trustedProxyClientKey` policy. On the Cloudflare Worker runtime
 * (`CLOUDFLARE_WORKERS === "true"`), `cf-connecting-ip` is trusted the same
 * way Node upload/voucher routes trust it. Railway still requires the
 * proxy secret before any Cloudflare or forwarded IP is accepted.
 * Unidentified visitors are not collapsed into one shared bucket.
 */
export function edgeTrustedClientKey(request: Request): string | null {
  const proxySecret = process.env.TRUSTED_PROXY_SHARED_SECRET;
  const trustCloudflareWorker = process.env.CLOUDFLARE_WORKERS === "true";

  if (trustCloudflareWorker) {
    const cfIp = normalizeIpToken(request.headers.get(CLOUDFLARE_IP_HEADER));
    if (cfIp) return `cf:${cfIp}`;
  }

  if (trustedProxyRequest(request, proxySecret) && proxySecret?.trim()) {
    const cfIp = normalizeIpToken(request.headers.get(CLOUDFLARE_IP_HEADER));
    if (cfIp) return `cf:${cfIp}`;
    const forwarded = rightmostForwardedIp(request.headers.get("x-forwarded-for"));
    if (forwarded) return `forwarded:${forwarded}`;
  }

  if (process.env.VERCEL === "1") {
    const vercel = rightmostForwardedIp(request.headers.get("x-vercel-forwarded-for"))
      ?? rightmostForwardedIp(request.headers.get("x-forwarded-for"))
      ?? normalizeIpToken(request.headers.get("x-real-ip"));
    if (vercel) return `vercel:${vercel}`;
  }

  void TRUSTED_PROXY_HEADER;
  return null;
}

function isImagePath(pathname: string): boolean {
  return pathname.endsWith("/image")
    || pathname.includes("/pixel-image")
    || pathname.includes("/listing-image")
    || pathname.includes("/pump/image");
}

function isPublicApiPath(pathname: string): boolean {
  return pathname.startsWith("/api/") || pathname.startsWith("/0xFi/api/");
}

export function publicApiRateLimitedResponse(request: Request, pathname: string): Response | null {
  if (pathname === "/api/health" || !isPublicApiPath(pathname)) return null;
  const clientKey = edgeTrustedClientKey(request);
  if (!clientKey) return null;

  const method = request.method.toUpperCase();
  const limiter = method === "GET" || method === "HEAD"
    ? (isImagePath(pathname) ? imageLimiter : readLimiter)
    : writeLimiter;
  if (limiter.consume([clientKey])) return null;

  return new Response(JSON.stringify({ error: "Too many requests" }), {
    status: 429,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "Retry-After": "60",
    },
  });
}
