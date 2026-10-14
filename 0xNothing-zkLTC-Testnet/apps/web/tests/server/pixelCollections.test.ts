import assert from "node:assert/strict";
import test from "node:test";
import { createBoundedCache } from "../../lib/boundedCache.ts";
import { getPixelImageUrl } from "../../lib/pixelImage.ts";
import { normalizeUint256TokenId } from "../../lib/tokenId.ts";
import { publicCdnCacheHeaders } from "../../lib/server/cdnCache.ts";
import { evaluateModule } from "../helpers/evaluateModule.ts";

const classic = `0x${"1".repeat(40)}` as const;
const current = `0x${"2".repeat(40)}` as const;
const owner = `0x${"3".repeat(40)}` as const;
const marketplace = `0x${"4".repeat(40)}` as const;
const collections = {
  PIXEL_MINT_ENABLED: true,
  PIXEL_COLLECTIONS: [{ address: classic, name: "0xPixel Classic" }, { address: current, name: "0xPixel" }],
  resolvePixelCollection: (value?: string | null) => !value ? classic : [classic, current].find((address) => address.toLowerCase() === value.toLowerCase()) ?? null,
  isPackedPixelCollection: (address: string) => address.toLowerCase() === current,
  isPixelCollection: (address: string) => [classic, current].some((collection) => collection === address.toLowerCase()),
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
    "@/lib/abi": { PixelClassicABI: [] },
    "@/lib/gridParser": { pixelDataToSVGMarkup: (pixels: string) => `<svg>${pixels}</svg>` },
    "@/lib/tokenId": { normalizeUint256TokenId },
    "@/lib/pixelCollections": collections,
  }, { URL, Response, console: quiet });
  const old = await route.GET(new Request("https://app.test/api/pixel-image?tokenId=1"));
  const next = await route.GET(new Request(`https://app.test/api/pixel-image?tokenId=1&collection=${current}`));
  assert.equal(await old.text(), `<svg>${classic}</svg>`);
  assert.equal(await next.text(), `<svg>${current}</svg>`);
  await route.GET(new Request(`https://app.test/api/pixel-image?tokenId=1&collection=${classic}`));
  assert.deepEqual(reads, [classic, current]);
  assert.match(next.headers.get("cache-control") ?? "", /immutable/);
  assert.equal((await route.GET(new Request(`https://app.test/api/pixel-image?tokenId=1&collection=${owner}`))).status, 400);
});

test("Classic and packed inventory are read from RPC and merge only validated NUSD listings", async () => {
  const enumerated: string[] = [];
  const listed: string[] = [];
  const route = evaluateModule<{ GET: (request: Request) => Promise<Response> }>(new URL("../../app/api/user-nfts/route.ts", import.meta.url), {
    "next/server": { NextResponse: Response },
    "@/lib/contract": {
      PIXEL_CLASSIC_CONTRACT_ADDRESS: classic,
      getUserTokenIds: async (_owner: string, collection: string) => { enumerated.push(collection); return [1n]; },
      publicClient: {
        getBlockNumber: async () => 100n,
        multicall: async ({ contracts }: { contracts: Array<{ functionName: string; args: unknown[] }> }) => contracts.map((contract) => {
          if (contract.functionName === "tokenPackedData") return { status: "success", result: ["Packed Art", "Description", 256n, "pixels", owner, 2n, ""] };
          if (contract.functionName === "tokenData") return { status: "success", result: ["Classic Art", 256n, "pixels", owner, 1n, ""] };
          throw new Error("Unexpected metadata read");
        }),
      },
    },
    "@/lib/pixelImage": { getPixelImageUrl }, "@/lib/abi": { PixelClassicABI: [] },
    "@/lib/nusdMarketplaceConfig": { NUSD_MARKETPLACE_ADDRESS: marketplace, NFT_NUSD_ADDRESS: owner },
    "@/lib/nusdMarketplaceInventory": { readNusdWalletListings: async (_client: unknown, market: string, _nusd: string, tokens: { collection: string; listing: unknown }[]) => {
      assert.equal(market, marketplace);
      assert.ok(tokens.every((token) => token.listing === null));
      listed.push(...tokens.map((token) => token.collection));
      return { [`${current}:1`]: { listingId: "2", price: "1000000000000000000" } };
    } },
    "@/lib/pixelNftAbi": { PixelNFTABI: [] },
    "@/lib/boundedCache": { createBoundedCache }, "@/lib/server/publicError": { publicErrorMessage: () => "unavailable" }, "@/lib/pixelCollections": collections,
  }, { URL, setTimeout, clearTimeout, console: quiet });
  const response = await route.GET(new Request(`https://app.test/api/user-nfts?address=${owner}`));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.tokens.length, 2);
  assert.deepEqual(body.tokens.map((nft: { collection: string }) => nft.collection), [classic, current]);
  assert.equal(body.tokens[1].imageUrl, getPixelImageUrl(1, current));
  assert.deepEqual(enumerated, [classic, current]);
  assert.deepEqual(listed, [classic, current]);
  assert.equal(body.tokens[0].listing, null);
  assert.deepEqual(body.tokens[1].listing, { listingId: "2", price: "1000000000000000000" });
});

test("metadata cache and RPC reads isolate equal token IDs in both collections", async () => {
  const reads: string[] = [];
  const route = evaluateModule<{ GET: (request: Request) => Promise<Response> }>(new URL("../../app/api/token-metadata/route.ts", import.meta.url), {
    "next/server": { NextResponse: Response },
    "@/lib/contract": { publicClient: { multicall: async ({ contracts }: { contracts: Array<{ address: string; functionName: string }> }) => contracts.map(({ address, functionName }) => {
      reads.push(address);
      assert.equal(functionName, address === current ? "tokenPackedData" : "tokenData");
      return { status: "success", result: address === current ? ["New", "User description 🖼", 8n, "0x000000ffffff", owner, 1n, ""] : ["Old", 8n, "pixels", owner, 1n, ""] };
    }) } },
    "@/lib/pixelNftAbi": { PixelNFTABI: [] },
    "@/lib/pixelCollections": collections, "@/lib/pixelImage": { getPixelImageUrl }, "@/lib/abi": { PixelClassicABI: [] },
    "@/lib/boundedCache": { createBoundedCache }, "@/lib/tokenId": { normalizeUint256TokenId },
    "@/lib/server/publicError": { publicErrorMessage: () => "unavailable" }, "@/lib/server/cdnCache": { publicCdnCacheHeaders },
  }, { URL, console: quiet });
  for (const collection of [classic, current, classic, current]) {
    const response = await route.GET(new Request(`https://app.test/api/token-metadata?ids=1&collection=${collection}`));
    const body = await response.json();
    assert.equal(body.tokens["1"].name, collection === current ? "New" : "Old");
    assert.equal(body.tokens["1"].description, collection === current ? "User description 🖼" : undefined);
  }
  assert.deepEqual(reads, [classic, current]);
});

test("NUSD marketplace hydration keeps both NFT generations without native listings", async () => {
  const nftReads: string[] = [];
  const route = evaluateModule<{ GET: (request: Request) => Promise<Response> }>(new URL("../../app/api/marketplace/listings/route.ts", import.meta.url), {
    "next/server": { NextResponse: Response },
    "@/lib/pixelCollections": collections,
    "@/lib/contract": {
      publicClient: {
        readContract: async () => [1n, 2n],
        multicall: async ({ contracts }: { contracts: Array<{ address: string; functionName: string; args: unknown[] }> }) => contracts.map((call) => {
          nftReads.push(call.address);
          assert.equal(call.functionName, call.address === current ? "tokenPackedData" : "tokenData");
          const result = call.address === current ? ["New Art", "", 256n, "pixels", owner, 1n, ""] : ["Classic Art", 256n, "pixels", owner, 1n, ""];
          return { status: "success", result };
        }),
      },
    },
    "@/lib/nusdMarketplaceConfig": { NUSD_MARKETPLACE_ADDRESS: marketplace, NFT_NUSD_ADDRESS: owner },
    "@/lib/nusdMarketplace": { readNusdMarket: async () => ({ blockNumber: 100n, listingCount: 2n, listings: [classic, current].map((collection, index) => ({ id: BigInt(index + 1), collection, tokenId: 1n, price: 5n, seller: owner, active: true })) }) },
    "@/lib/pixelNftAbi": { PixelNFTABI: [] }, "@/lib/abi": { PixelClassicABI: [] },
    "@/lib/pixelImage": { getPixelImageUrl },
    "@/lib/erc721Metadata.server": { fetchValidatedErc721Metadata: async () => ({}) }, "@/lib/boundedCache": { createBoundedCache },
    "@/lib/server/cdnCache": { publicCdnCacheHeaders },
  }, { URL, setTimeout, clearTimeout, console: quiet });
  const response = await route.GET(new Request("https://app.test/api/marketplace/listings"));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.listings.length, 2);
  assert.equal(body.currency, "NUSD");
  assert.equal(body.marketplace, marketplace);
  assert.equal(body.tokens[`${classic}:1`].name, "Classic Art");
  assert.equal(body.tokens[`${current}:1`].name, "New Art");
  assert.notEqual(body.tokens[`${classic}:1`].imageUrl, body.tokens[`${current}:1`].imageUrl);
  assert.deepEqual(nftReads, [classic, current]);
});
