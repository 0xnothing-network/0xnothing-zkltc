import assert from "node:assert/strict";
import test from "node:test";
import { createBoundedCache } from "../../lib/boundedCache.ts";
import { publicCdnCacheHeaders } from "../../lib/server/cdnCache.ts";
import { PublicRouteError, publicErrorMessage } from "../../lib/server/publicError.ts";
import { evaluateModule } from "../helpers/evaluateModule.ts";

const collection = `0x${"1".repeat(40)}`;
const seller = `0x${"2".repeat(40)}`;
const marketplace = `0x${"3".repeat(40)}`;

function candleHarness() {
  const queriedPeriods: number[] = [];
  const route = evaluateModule<{ GET: (request: { nextUrl: URL }) => Promise<Response> }>(
    new URL("../../app/0xFi/api/data/candles/route.ts", import.meta.url),
    {
      "next/server": { NextResponse: Response },
      viem: { createPublicClient: () => ({}), http: () => ({}), isAddress: () => false },
      "@fi/config/assets": {
        canonicalPairs: [["TOKEN", "NUSD"]],
        pairSlug: () => "token-nusd",
        parsePairSlug: () => ["TOKEN", "NUSD"],
        deployedPairForSlug: () => collection,
      },
      "@fi/lib/server/goldsky": {
        queryGoldsky: async (_query: string, variables: { period: number }) => {
          queriedPeriods.push(variables.period);
          return { data: [], meta: { indexedBlock: 1, rpcTail: {} } };
        },
      },
      "@fi/config/deployment": { deployment: { chain: { rpcUrl: "https://rpc.invalid" }, contracts: {} } },
      "@fi/lib/abis/dia": { diaOracleAdapterAbi: [] },
      "@fi/lib/canonicalMarkets": { canonicalOracleMarketForIdentifier: () => undefined },
      "@fi/lib/server/rpcTail": {
        loadPairTail: async () => ({ events: [], capped: false, fromBlock: 2n, toBlock: 2n }),
        pairTokenMetadata: async () => ({ token0: collection, token1: seller, decimals0: 18, decimals1: 18 }),
      },
      "@/lib/boundedCache": { createBoundedCache },
      "@/lib/server/cdnCache": { publicCdnCacheHeaders },
      "@/lib/server/publicError": { PublicRouteError, publicErrorMessage },
    },
    { console: { warn() {}, error() {} } },
  );
  return { queriedPeriods, get: (period: string) => route.GET({ nextUrl: new URL(`https://app.test/0xFi/api/data/candles?pair=token-nusd&period=${period}`) }) };
}

test("candle API rejects inherited object keys before querying either data source", async () => {
  const harness = candleHarness();
  for (const period of ["constructor", "__proto__", "toString", "valueOf", "hasOwnProperty", "10m"]) {
    const response = await harness.get(period);
    assert.equal(response.status, 400, period);
    assert.equal(response.headers.get("cache-control"), "no-store");
  }
  assert.deepEqual(harness.queriedPeriods, []);
});

test("candle API preserves every supported period", async () => {
  const harness = candleHarness();
  for (const period of ["5m", "1h", "4h", "1d"]) assert.equal((await harness.get(period)).status, 200);
  assert.deepEqual(harness.queriedPeriods, [300, 3_600, 14_400, 86_400]);
});

test("marketplace uses verified RPC metadata when indexed metadata has no image", async () => {
  const route = evaluateModule<{ GET: (request: Request) => Promise<Response> }>(
    new URL("../../app/api/marketplace/listings/route.ts", import.meta.url),
    {
      "next/server": { NextResponse: Response },
      "@/lib/contract": {
        PIXEL_NFT_CONTRACT_ADDRESS: collection,
        PIXEL_MARKETPLACE_ADDRESS: marketplace,
        publicClient: {
          multicall: async ({ contracts }: { contracts: Array<{ functionName: string }> }) => contracts.map(({ functionName }) => ({
            status: "success",
            result: functionName === "ownerOf" ? seller
              : functionName === "getApproved" ? marketplace
                : functionName === "listings" ? [collection, 1n, 5n, seller, true]
                  : functionName === "isApprovedForAll" ? false
                    : ["Verified live image", 8n, "pixels", seller, 123n, ""],
          })),
        },
      },
      "@/lib/marketplaceAbi": { MarketplaceAbi: [], marketplaceNftKey: (address: string, tokenId: string) => `${address}:${tokenId}` },
      "@/lib/abi": { PixelNFTABI: [] },
      "@/lib/pixelImage": { getPixelImageUrl: (tokenId: string) => `/api/pixel-image?tokenId=${tokenId}` },
      "@/lib/marketplaceSubgraph": {
        hasMarketplaceSubgraph: () => true,
        fetchAllMarketplaceListingsFromSubgraph: async () => [{ listingId: "1", collection, tokenId: "1", price: "5", seller, active: true }],
        fetchTokenMetadataFromSubgraph: async () => ({ "1": { tokenId: "1", name: "Incomplete index", imageUrl: "", creator: seller, mintedAt: 0 } }),
      },
      "@/lib/erc721Metadata.server": { fetchValidatedErc721Metadata: async () => ({}) },
      "@/lib/boundedCache": { createBoundedCache },
      "@/lib/server/cdnCache": { publicCdnCacheHeaders },
    },
    { URL, setTimeout, clearTimeout, console: { warn() {}, error() {} } },
  );
  const response = await route.GET(new Request("https://app.test/api/marketplace/listings"));
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.listings.length, 1);
  assert.equal(payload.tokens[`${collection}:1`].imageUrl, "/api/pixel-image?tokenId=1");
  assert.equal(payload.tokens[`${collection}:1`].name, "Verified live image");
});
