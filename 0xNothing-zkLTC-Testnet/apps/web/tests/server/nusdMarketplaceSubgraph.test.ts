import assert from "node:assert/strict";
import test from "node:test";
import * as viem from "viem";
import * as marketplace from "../../lib/nusdMarketplace.ts";
import type { readNusdActivityFromSubgraph } from "../../lib/nusdMarketplaceSubgraph.ts";
import { evaluateModule } from "../helpers/evaluateModule.ts";

const NFT = "0x0000000000000000000000000000000000000033";
const SELLER = "0x0000000000000000000000000000000000000055";
const BUYER = "0x0000000000000000000000000000000000000066";
const HASH = `0x${"ab".repeat(32)}`;
const activity = evaluateModule<Record<string, unknown>>(new URL("../../lib/nusdMarketplaceActivity.ts", import.meta.url), { viem, "./nusdMarketplace": marketplace }, { Error });
const { readNusdActivityFromSubgraph: read } = evaluateModule<{ readNusdActivityFromSubgraph: typeof readNusdActivityFromSubgraph }>(
  new URL("../../lib/nusdMarketplaceSubgraph.ts", import.meta.url), { viem, "./nusdMarketplaceActivity": activity }, { Error, AbortSignal, JSON },
);

function row(blockNumber: number, logIndex: number, extra: Record<string, unknown> = {}) {
  return { id: `${HASH}-${logIndex}`, type: "BOUGHT", collection: NFT, tokenId: "7", actor: SELLER, other: BUYER, price: "1000000000000000001", blockNumber: String(blockNumber), logIndex: String(logIndex), timestamp: "1700000000", transactionHash: HASH, ...extra };
}

function server(body: unknown, init: { status?: number } = {}) {
  const requests: { first: number; before: string; types: string[] }[] = [];
  const fetcher = (async (_url: string, request: { body: string }) => {
    requests.push(JSON.parse(request.body).variables);
    return new Response(JSON.stringify(body), { status: init.status ?? 200 });
  }) as unknown as typeof fetch;
  return { fetcher, requests };
}

test("subgraph history maps rows to the RPC event shape and pages with block:logIndex cursors", async () => {
  const rows = [row(100, 9), row(100, 8, { type: "UPDATED", other: null }), row(99, 2, { type: "MINTED", price: null, other: null })];
  const api = server({ data: { activities: rows, _meta: { block: { number: 120 }, hasIndexingErrors: false } } });
  const page = await read("https://graph.test", { filter: "ALL", limit: 2, latestBlock: 125n }, api.fetcher);
  assert.equal(api.requests[0].first, 3);
  assert.equal(page.events.length, 2);
  assert.equal(page.events[0].id, `${HASH}:9`);
  assert.equal(page.events[0].price, "1000000000000000001");
  assert.equal(page.events[0].other, BUYER);
  assert.equal(page.events[1].other, undefined);
  assert.equal(page.nextCursor, "100:8");
  const older = server({ data: { activities: [row(99, 2, { type: "MINTED", price: null, other: null })], _meta: { block: { number: 120 }, hasIndexingErrors: false } } });
  const next = await read("https://graph.test", { filter: "ALL", limit: 2, cursor: page.nextCursor }, older.fetcher);
  assert.equal(older.requests[0].before, (100n * 2n ** 32n + 8n).toString());
  assert.equal(next.events[0].price, null);
  assert.equal(next.nextCursor, null);
});

test("subgraph filters send the same type groups as the RPC feed", async () => {
  const api = server({ data: { activities: [], _meta: { block: { number: 1 }, hasIndexingErrors: false } } });
  await read("https://graph.test", { filter: "LISTED", limit: 5 }, api.fetcher);
  await read("https://graph.test", { filter: "OFFERS", limit: 5 }, api.fetcher);
  assert.deepEqual(Array.from(api.requests[0].types), ["LISTED", "UPDATED"]);
  assert.deepEqual(Array.from(api.requests[1].types), ["OFFER_CREATED", "OFFER_REFUNDED"]);
});

test("lagging, failing or malformed subgraph responses are rejected for the RPC fallback", async () => {
  const meta = { block: { number: 100 }, hasIndexingErrors: false };
  const cases: [unknown, { status?: number }, bigint | undefined][] = [
    [{ data: { activities: [], _meta: meta } }, {}, 100n + 1_201n],
    [{ data: { activities: [], _meta: { ...meta, hasIndexingErrors: true } } }, {}, undefined],
    [{ errors: [{ message: "secret" }] }, {}, undefined],
    [{ data: { activities: [], _meta: meta } }, { status: 502 }, undefined],
    [{ data: { activities: [row(100, 1, { actor: "not-an-address" })], _meta: meta } }, {}, undefined],
    [{ data: { activities: [row(100, 1, { type: "NATIVE_SALE" })], _meta: meta } }, {}, undefined],
    [{ data: { activities: [row(100, 1, { transactionHash: "0x12" })], _meta: meta } }, {}, undefined],
  ];
  for (const [body, init, latestBlock] of cases) {
    const api = server(body, init);
    await assert.rejects(read("https://graph.test", { filter: "ALL", limit: 2, latestBlock }, api.fetcher));
  }
  const lagWithCursor = server({ data: { activities: [], _meta: meta } });
  const page = await read("https://graph.test", { filter: "ALL", limit: 2, cursor: "50:0", latestBlock: 10_000n }, lagWithCursor.fetcher);
  assert.equal(page.events.length, 0);
});
