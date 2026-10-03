import assert from "node:assert/strict";
import test from "node:test";
import { createBoundedCache } from "../../lib/boundedCache.ts";
import { normalizeUint256TokenId } from "../../lib/tokenId.ts";
import { publicCdnCacheHeaders } from "../../lib/server/cdnCache.ts";
import { evaluateModule } from "../helpers/evaluateModule.ts";

const collection = `0x${"1".repeat(40)}` as const;
const creator = `0x${"2".repeat(40)}`;

test("partial metadata failures stay off CDN while healthy metadata retains public caching", async () => {
  const batches: string[][] = [];
  const route = evaluateModule<{ GET: (request: Request) => Promise<Response> }>(
    new URL("../../app/api/token-metadata/route.ts", import.meta.url),
    {
      "next/server": { NextResponse: Response },
      "@/lib/pixelCollections": {
        resolvePixelCollection: () => collection,
        pixelTokenKey: (address: string, id: string) => `${address}:${id}`,
        isPixelV2Collection: () => false,
      },
      "@/lib/contract": { publicClient: { multicall: async ({ contracts }: { contracts: Array<{ args: bigint[] }> }) => {
        batches.push(Array.from(contracts, ({ args }) => String(args[0])));
        return contracts.map(({ args }) => args[0] === 2n ? { status: "failure", error: new Error("transient RPC error") }
          : { status: "success", result: ["Art", 8n, "pixels", creator, 1n, ""] });
      } } },
      "@/lib/abi": { PixelNFTABI: [] },
      "@/lib/pixelV2Abi": { PixelV2ABI: [] },
      "@/lib/pixelImage": { getPixelImageUrl: (id: string) => `/api/pixel-image?tokenId=${id}` },
      "@/lib/marketplaceSubgraph": { hasMarketplaceSubgraph: () => false },
      "@/lib/boundedCache": { createBoundedCache },
      "@/lib/server/publicError": { publicErrorMessage: () => "unavailable" },
      "@/lib/tokenId": { normalizeUint256TokenId },
      "@/lib/server/cdnCache": { publicCdnCacheHeaders },
    },
    { URL, console: { warn() {}, error() {} } },
  );
  const get = (ids: string) => route.GET(new Request(`https://app.test/api/token-metadata?ids=${ids}`));
  const partial = await get("1,2");
  assert.equal(partial.status, 200);
  const body = await partial.json();
  assert.equal(body.tokens["1"].name, "Art");
  assert.equal(body.tokens["2"], null);
  assert.equal(partial.headers.get("cache-control"), "no-store");
  assert.equal(partial.headers.get("cloudflare-cdn-cache-control"), "no-store");
  const repeated = await get("2");
  assert.equal(repeated.headers.get("cache-control"), "no-store", "locally cached errors remain uncacheable by CDN");
  const healthy = await get("1,3");
  assert.match(healthy.headers.get("cache-control") ?? "", /s-maxage=30/);
  assert.match(healthy.headers.get("cloudflare-cdn-cache-control") ?? "", /max-age=30/);
  assert.deepEqual(batches, [["1", "2"], ["3"]], "local miss throttling and successful metadata reuse are preserved");
});
