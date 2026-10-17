import assert from "node:assert/strict";
import test from "node:test";
import { publicCdnCacheHeaders } from "../../lib/server/cdnCache.ts";

test("publicCdnCacheHeaders preserves the browser cache policy and gives each CDN its own ttl", () => {
  assert.deepEqual(
    publicCdnCacheHeaders(
      "public, max-age=0, s-maxage=2, stale-while-revalidate=8",
      2,
      600,
    ),
    {
      "Cache-Control": "public, max-age=0, s-maxage=2, stale-while-revalidate=8",
      "Vercel-CDN-Cache-Control": "public, max-age=2, stale-while-revalidate=600",
      "Cloudflare-CDN-Cache-Control": "public, max-age=2, stale-while-revalidate=600",
    },
  );
});
