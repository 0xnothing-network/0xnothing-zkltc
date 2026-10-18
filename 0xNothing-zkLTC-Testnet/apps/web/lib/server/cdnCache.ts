/**
 * Seconds a CDN may keep answering a public read from its last copy while it fetches a
 * fresh one in the background. Traffic is light, so most visits arrive after the short
 * freshness window and used to wait for a full Goldsky and RPC load. Every view polls
 * within seconds and replaces that first answer, and active users stay inside the
 * freshness window, so they see the same data as before.
 */
export const CDN_STALE_SECONDS = 600;

/** A page that already shows this route's data asks for current data (see lib/http.ts). */
export function isFreshRead(request: Request): boolean {
  return new URL(request.url).searchParams.get("fresh") === "1";
}

/**
 * `cacheControl` keeps its meaning for browsers. Vercel and Cloudflare each cache by
 * their own header, which browsers ignore, so a long CDN stale window never makes a
 * browser reuse an old answer.
 */
export function publicCdnCacheHeaders(
  cacheControl: string,
  maxAge: number,
  staleWhileRevalidate: number,
): Record<string, string> {
  const cdnCacheControl = `public, max-age=${maxAge}, stale-while-revalidate=${staleWhileRevalidate}`;
  return {
    "Cache-Control": cacheControl,
    "Vercel-CDN-Cache-Control": cdnCacheControl,
    "Cloudflare-CDN-Cache-Control": cdnCacheControl,
  };
}
