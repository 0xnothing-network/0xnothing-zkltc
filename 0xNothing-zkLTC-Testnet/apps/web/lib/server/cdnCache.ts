export function publicCdnCacheHeaders(
  cacheControl: string,
  maxAge: number,
  staleWhileRevalidate: number,
): Record<string, string> {
  return {
    "Cache-Control": cacheControl,
    "Cloudflare-CDN-Cache-Control":
      `public, max-age=${maxAge}, stale-while-revalidate=${staleWhileRevalidate}`,
  };
}
