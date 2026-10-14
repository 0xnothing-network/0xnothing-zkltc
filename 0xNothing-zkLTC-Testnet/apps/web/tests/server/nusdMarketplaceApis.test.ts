import assert from "node:assert/strict";
import test from "node:test";
import * as viem from "viem";
import * as marketplace from "../../lib/nusdMarketplace.ts";
import type { readNusdMarketActivity, NusdActivityPage } from "../../lib/nusdMarketplaceActivity.ts";
import { createBoundedCache } from "../../lib/boundedCache.ts";
import { publicCdnCacheHeaders } from "../../lib/server/cdnCache.ts";
import { evaluateModule } from "../helpers/evaluateModule.ts";

const MARKET = "0x0000000000000000000000000000000000000011";
const NUSD = "0x0000000000000000000000000000000000000022";
const NFT = "0x0000000000000000000000000000000000000033";
const history = evaluateModule<{ parseNusdActivityCursor: (cursor: string | null) => unknown }>(new URL("../../lib/nusdMarketplaceActivity.ts", import.meta.url), { viem, "./nusdMarketplace": marketplace }, { Error });
function activityHarness(options: { configured?: boolean; fail?: boolean } = {}) {
  const calls: Parameters<typeof readNusdMarketActivity>[1][] = [];
  const route = evaluateModule<{ GET: (request: Request) => Promise<Response> }>(new URL("../../app/api/marketplace/activity/route.ts", import.meta.url), {
    "next/server": { NextResponse: Response }, "@/lib/contract": { publicClient: {} },
    "@/lib/boundedCache": { createBoundedCache }, "@/lib/server/cdnCache": { publicCdnCacheHeaders },
    "@/lib/nusdMarketplaceConfig": { NUSD_MARKETPLACE_ADDRESS: options.configured === false ? undefined : MARKET, NFT_NUSD_ADDRESS: NUSD },
    "@/lib/pixelCollections": { PIXEL_COLLECTIONS: [{ address: NFT }] },
    "@/lib/nusdMarketplace.generated.json": { default: { address: MARKET, deploymentBlock: "900" } },
    "@/lib/nusdMarketplaceActivity": { parseNusdActivityCursor: history.parseNusdActivityCursor, readNusdMarketActivity: async (_client: unknown, params: typeof calls[number]): Promise<NusdActivityPage> => {
      calls.push(params);
      if (options.fail) throw new Error("secret RPC diagnostic");
      return { events: [], nextCursor: "900:0", fromBlock: "900", throughBlock: "1000" };
    } },
  }, { URL });
  return { calls, get: (search = "") => route.GET(new Request(`https://app.test/api/marketplace/activity${search}`)) };
}

test("activity API validates filters, cursors and limits before RPC, with NUSD deployment bounds", async () => {
  const api = activityHarness();
  for (const search of ["?type=unknown", "?limit=-1", "?limit=101", "?limit=1.5", "?cursor=1:-1", "?cursor=1:2147483648"]) assert.equal((await api.get(search)).status, 400);
  assert.equal(api.calls.length, 0);
  const response = await api.get("?type=offers&limit=2&cursor=999:4");
  assert.equal(response.status, 200);
  assert.equal(api.calls[0].market, MARKET);
  assert.equal(api.calls[0].nusd, NUSD);
  assert.equal(api.calls[0].deploymentBlock, 900n);
  assert.equal(api.calls[0].filter, "OFFERS");
  assert.equal(api.calls[0].cursor, "999:4");
  assert.equal(api.calls[0].limit, 2);
});

test("activity API shares bounded cache, forces fresh reads and never leaks RPC failure details", async () => {
  const api = activityHarness();
  await api.get(); await api.get();
  assert.equal(api.calls.length, 1);
  const forced = await api.get("?force=1");
  assert.equal(api.calls.length, 2);
  assert.match(forced.headers.get("cache-control") ?? "", /no-store/);
  const failed = await activityHarness({ fail: true }).get();
  assert.equal(failed.status, 503);
  assert.match(failed.headers.get("cache-control") ?? "", /no-store/);
  assert.doesNotMatch(await failed.text(), /secret|native|zkLTC/);
  const disabled = activityHarness({ configured: false });
  assert.equal((await disabled.get()).status, 503);
  assert.equal(disabled.calls.length, 0);
});

test("activity without a recorded marketplace address starts from block 0", async () => {
  const calls: { deploymentBlock: bigint }[] = [];
  const route = evaluateModule<{ GET: (request: Request) => Promise<Response> }>(new URL("../../app/api/marketplace/activity/route.ts", import.meta.url), {
    "next/server": { NextResponse: Response }, "@/lib/contract": { publicClient: {} },
    "@/lib/boundedCache": { createBoundedCache }, "@/lib/server/cdnCache": { publicCdnCacheHeaders },
    "@/lib/nusdMarketplaceConfig": { NUSD_MARKETPLACE_ADDRESS: MARKET, NFT_NUSD_ADDRESS: NUSD },
    "@/lib/pixelCollections": { PIXEL_COLLECTIONS: [{ address: NFT }] },
    "@/lib/nusdMarketplace.generated.json": { default: { address: null, deploymentBlock: null } },
    "@/lib/nusdMarketplaceActivity": { parseNusdActivityCursor: history.parseNusdActivityCursor, readNusdMarketActivity: async (_client: unknown, params: { deploymentBlock: bigint }) => {
      calls.push(params);
      return { events: [], nextCursor: null, fromBlock: "0", throughBlock: "0" };
    } },
  }, { URL });
  assert.equal((await route.GET(new Request("https://app.test/api/marketplace/activity"))).status, 200);
  assert.equal(calls[0].deploymentBlock, 0n);
});

function listingHarness(options: { configured?: boolean; fail?: boolean } = {}) {
  let reads = 0;
  const route = evaluateModule<{ GET: (request: Request) => Promise<Response> }>(new URL("../../app/api/marketplace/listings/route.ts", import.meta.url), {
    "next/server": { NextResponse: Response }, "@/lib/contract": { publicClient: {} },
    "@/lib/nusdMarketplaceConfig": { NUSD_MARKETPLACE_ADDRESS: options.configured === false ? undefined : MARKET, NFT_NUSD_ADDRESS: NUSD },
    "@/lib/nusdMarketplace": { readNusdMarket: async (_client: unknown, market: string, token: string, account: unknown, page: number) => {
      reads += 1;
      assert.equal(market, MARKET); assert.equal(token, NUSD); assert.equal(account, undefined);
      if (options.fail) throw new Error("secret identity mismatch");
      return { blockNumber: 1000n, listingCount: 50n, listings: [{ id: BigInt(page + 1), collection: NFT, tokenId: 3n, price: 1000000000000000001n, seller: NUSD, active: true }] };
    } },
    "@/lib/pixelCollections": { PIXEL_COLLECTIONS: [], isPixelCollection: () => false, isPixelV2Collection: () => false, pixelTokenKey: (collection: string, tokenId: string) => `${collection}:${tokenId}` },
    "@/lib/abi": {}, "@/lib/pixelV2Abi": {}, "@/lib/pixelImage": {},
    "@/lib/marketplaceSubgraph": { hasMarketplaceSubgraph: () => false },
    "@/lib/erc721Metadata.server": { fetchValidatedErc721Metadata: async () => ({}) },
    "@/lib/boundedCache": { createBoundedCache }, "@/lib/server/cdnCache": { publicCdnCacheHeaders },
  }, { URL });
  return { reads: () => reads, get: (search = "") => route.GET(new Request(`https://app.test/api/marketplace/listings${search}`)) };
}

test("canonical listings API serves exact NUSD amounts with bounded validated pages, never native fallback", async () => {
  const api = listingHarness();
  for (const page of ["-1", "1.5", "1e2", "9007199254740992"]) assert.equal((await api.get(`?page=${page}`)).status, 400);
  assert.equal(api.reads(), 0);
  const body = await (await api.get("?page=1")).json();
  assert.equal(body.currency, "NUSD");
  assert.equal(body.listings[0].price, "1000000000000000001");
  assert.equal(body.page, 1);
  assert.equal(body.totalCount, "50");
  await api.get("?page=1");
  assert.equal(api.reads(), 1);
  await api.get("?page=1&force=1");
  assert.equal(api.reads(), 2);
  const failed = await listingHarness({ fail: true }).get();
  assert.equal(failed.status, 503);
  assert.doesNotMatch(await failed.text(), /secret|zkLTC/);
  const disabled = listingHarness({ configured: false });
  assert.equal((await disabled.get()).status, 503);
  assert.equal(disabled.reads(), 0);
});
