import assert from "node:assert/strict";
import test from "node:test";
import { createBoundedCache } from "../../lib/boundedCache.ts";
import { getPixelImageUrl } from "../../lib/pixelImage.ts";
import { normalizeUint256TokenId } from "../../lib/tokenId.ts";
import { publicCdnCacheHeaders } from "../../lib/server/cdnCache.ts";
import { evaluateModule } from "../helpers/evaluateModule.ts";

const legacy = `0x${"1".repeat(40)}` as const;
const v2 = `0x${"2".repeat(40)}` as const;
const owner = `0x${"3".repeat(40)}` as const;
const marketplace = `0x${"4".repeat(40)}` as const;
const collections = {
  PIXEL_V2_ENABLED: true,
  PIXEL_COLLECTIONS: [{ address: legacy, version: 1 }, { address: v2, version: 2 }],
  resolvePixelCollection: (value?: string | null) => !value ? legacy : [legacy, v2].find((address) => address.toLowerCase() === value.toLowerCase()) ?? null,
  isPixelV2Collection: (address: string) => address.toLowerCase() === v2,
  isPixelCollection: (address: string) => [legacy, v2].some((collection) => collection === address.toLowerCase()),
  pixelTokenKey: (address: string, id: string) => `${address.toLowerCase()}:${id}`,
};
const quiet = { warn() {}, error() {} };

test("immutable pixel-image reads and cache arguments distinguish collection plus token ID", async () => {
  const reads: string[] = [];
  const cache = new Map<string, unknown>();
  const route = evaluateModule<{ GET: (request: Request) => Promise<Response> }>(new URL("../../app/api/pixel-image/route.ts", import.meta.url), {
    "next/cache": { unstable_cache: (read: (...args: string[]) => Promise<unknown>) => async (...args: string[]) => {
      const key = JSON.stringify(args);
      if (!cache.has(key)) cache.set(key, await read(...args));
      return cache.get(key);
    } },
    "@/lib/contract": { publicClient: { readContract: async ({ address }: { address: string }) => { reads.push(address); return ["Art", 8n, address, owner, 1n, ""]; } } },
    "@/lib/abi": { PixelNFTABI: [] },
    "@/lib/gridParser": { pixelDataToSVGMarkup: (pixels: string) => `<svg>${pixels}</svg>` },
    "@/lib/tokenId": { normalizeUint256TokenId },
    "@/lib/pixelCollections": collections,
  }, { URL, Response, console: quiet });
  const old = await route.GET(new Request("https://app.test/api/pixel-image?tokenId=1"));
  const next = await route.GET(new Request(`https://app.test/api/pixel-image?tokenId=1&collection=${v2}`));
  assert.equal(await old.text(), `<svg>${legacy}</svg>`);
  assert.equal(await next.text(), `<svg>${v2}</svg>`);
  await route.GET(new Request(`https://app.test/api/pixel-image?tokenId=1&collection=${legacy}`));
  assert.deepEqual(reads, [legacy, v2]);
  assert.match(next.headers.get("cache-control") ?? "", /immutable/);
  assert.equal((await route.GET(new Request(`https://app.test/api/pixel-image?tokenId=1&collection=${owner}`))).status, 400);
});

test("fresh legacy inventory still merges V2 RPC inventory with matching collection listing calls", async () => {
  const enumerated: string[] = [];
  const listed: string[] = [];
  const route = evaluateModule<{ GET: (request: Request) => Promise<Response> }>(new URL("../../app/api/user-nfts/route.ts", import.meta.url), {
    "next/server": { NextResponse: Response },
    "@/lib/contract": {
      PIXEL_NFT_CONTRACT_ADDRESS: legacy, PIXEL_MARKETPLACE_ADDRESS: marketplace,
      getUserTokenIds: async (_owner: string, collection: string) => { enumerated.push(collection); return [1n]; },
      publicClient: {
        getBlockNumber: async () => 100n,
        multicall: async ({ contracts }: { contracts: Array<{ functionName: string; args: unknown[] }> }) => contracts.map((contract) => {
          if (contract.functionName === "tokenData") return { status: "success", result: ["V2 Art", 256n, "pixels", owner, 2n, ""] };
          listed.push(String(contract.args[0]));
          return { status: "success", result: [0n, { active: false }] };
        }),
      },
    },
    "@/lib/pixelImage": { getPixelImageUrl }, "@/lib/marketplaceAbi": { MarketplaceAbi: [] }, "@/lib/abi": { PixelNFTABI: [] },
    "@/lib/marketplaceSubgraph": {
      hasMarketplaceSubgraph: () => true,
      fetchUserNftsFromSubgraph: async () => ({ tokens: [{ tokenId: "1", name: "Legacy Art", imageUrl: "old.svg", listing: null }], indexedBlock: 100, hasIndexingErrors: false }),
    },
    "@/lib/boundedCache": { createBoundedCache }, "@/lib/server/publicError": { publicErrorMessage: () => "unavailable" }, "@/lib/pixelCollections": collections,
  }, { URL, setTimeout, clearTimeout, console: quiet });
  const response = await route.GET(new Request(`https://app.test/api/user-nfts?address=${owner}`));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.tokens.length, 2);
  assert.deepEqual(body.tokens.map((nft: { collection: string }) => nft.collection), [legacy, v2]);
  assert.equal(body.tokens[1].imageUrl, getPixelImageUrl(1, v2));
  assert.deepEqual(enumerated, [v2]);
  assert.deepEqual(listed, [v2]);
});

test("metadata cache and RPC fallback isolate equal token IDs in legacy and V2", async () => {
  const reads: string[] = [];
  let indexed = 0;
  const route = evaluateModule<{ GET: (request: Request) => Promise<Response> }>(new URL("../../app/api/token-metadata/route.ts", import.meta.url), {
    "next/server": { NextResponse: Response },
    "@/lib/contract": { publicClient: { multicall: async ({ contracts }: { contracts: Array<{ address: string; functionName: string }> }) => contracts.map(({ address, functionName }) => {
      reads.push(address);
      assert.equal(functionName, address === v2 ? "tokenPackedData" : "tokenData");
      return { status: "success", result: address === v2 ? ["New", "User description 🖼", 8n, "0x000000ffffff", owner, 1n, ""] : ["Old", 8n, "pixels", owner, 1n, ""] };
    }) } },
    "@/lib/pixelV2Abi": { PixelV2ABI: [] },
    "@/lib/pixelCollections": collections, "@/lib/pixelImage": { getPixelImageUrl }, "@/lib/abi": { PixelNFTABI: [] },
    "@/lib/marketplaceSubgraph": { hasMarketplaceSubgraph: () => true, fetchTokenMetadataFromSubgraph: async () => { indexed++; return {}; } },
    "@/lib/boundedCache": { createBoundedCache }, "@/lib/tokenId": { normalizeUint256TokenId },
    "@/lib/server/publicError": { publicErrorMessage: () => "unavailable" }, "@/lib/server/cdnCache": { publicCdnCacheHeaders },
  }, { URL, console: quiet });
  for (const collection of [legacy, v2, legacy, v2]) {
    const response = await route.GET(new Request(`https://app.test/api/token-metadata?ids=1&collection=${collection}`));
    const body = await response.json();
    assert.equal(body.tokens["1"].name, collection === v2 ? "New" : "Old");
    assert.equal(body.tokens["1"].description, collection === v2 ? "User description 🖼" : undefined);
  }
  assert.deepEqual(reads, [legacy, v2]);
  assert.equal(indexed, 1, "V2 never accepts the legacy-only index as its inventory");
});

test("marketplace RPC inventory and Pixel hydration keep both generations with equal token IDs", async () => {
  let indexedListings = 0;
  const nftReads: string[] = [];
  const listing = (id: bigint) => [id === 1n ? legacy : v2, 1n, 5n, owner, true];
  const route = evaluateModule<{ GET: (request: Request) => Promise<Response> }>(new URL("../../app/api/marketplace/listings/route.ts", import.meta.url), {
    "next/server": { NextResponse: Response },
    "@/lib/pixelCollections": collections,
    "@/lib/contract": {
      PIXEL_MARKETPLACE_ADDRESS: marketplace,
      publicClient: {
        readContract: async () => [1n, 2n],
        multicall: async ({ contracts }: { contracts: Array<{ address: string; functionName: string; args: unknown[] }> }) => contracts.map((call) => {
          const result = call.functionName === "listings" ? listing(call.args[0] as bigint)
            : call.functionName === "ownerOf" ? owner
              : call.functionName === "getApproved" ? marketplace
                : call.functionName === "isApprovedForAll" ? false
                  : (() => { nftReads.push(call.address); return [call.address === v2 ? "New Art" : "Legacy Art", 256n, "pixels", owner, 1n, ""]; })();
          return { status: "success", result };
        }),
      },
    },
    "@/lib/marketplaceAbi": { MarketplaceAbi: [], marketplaceNftKey: collections.pixelTokenKey }, "@/lib/abi": { PixelNFTABI: [] },
    "@/lib/pixelImage": { getPixelImageUrl },
    "@/lib/marketplaceSubgraph": {
      hasMarketplaceSubgraph: () => true,
      fetchAllMarketplaceListingsFromSubgraph: async () => { indexedListings++; return []; },
      fetchTokenMetadataFromSubgraph: async () => ({}),
    },
    "@/lib/erc721Metadata.server": { fetchValidatedErc721Metadata: async () => ({}) }, "@/lib/boundedCache": { createBoundedCache },
    "@/lib/server/cdnCache": { publicCdnCacheHeaders },
  }, { URL, setTimeout, clearTimeout, console: quiet });
  const response = await route.GET(new Request("https://app.test/api/marketplace/listings"));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.listings.length, 2);
  assert.equal(body.tokens[`${legacy}:1`].name, "Legacy Art");
  assert.equal(body.tokens[`${v2}:1`].name, "New Art");
  assert.notEqual(body.tokens[`${legacy}:1`].imageUrl, body.tokens[`${v2}:1`].imageUrl);
  assert.deepEqual(nftReads, [legacy, v2]);
  assert.equal(indexedListings, 0, "the old index cannot hide a new collection's listing");
});
