import assert from "node:assert/strict";
import test from "node:test";
import { formatUnits, getAddress, zeroAddress, type Address } from "viem";
import { NUSD_MARKET_IMPLEMENTATION, NUSD_MARKET_PAGE_SIZE, NUSD_MAX_PRICE, NusdMarketplaceAbi, nusdMarketplaceAddress, nusdFunding, offerExpiry, parseNusdPrice, readNusdMarket, requireFreshNusdMarket } from "../../lib/nusdMarketplace.ts";

const MARKET = getAddress("0x0000000000000000000000000000000000000011");
const NUSD = getAddress("0x0000000000000000000000000000000000000022");
const NFT = getAddress("0x0000000000000000000000000000000000000033");
const ACCOUNT = getAddress("0x0000000000000000000000000000000000000044");
const SELLER = getAddress("0x0000000000000000000000000000000000000055");
const UNIT = 10n ** 18n;

test("NUSD prices are exact, positive, bounded and never silently rounded", () => {
  assert.equal(parseNusdPrice(" 100.25 "), 10025n * UNIT / 100n);
  assert.equal(parseNusdPrice("0.000000000000000001"), 1n);
  assert.equal(parseNusdPrice(formatUnits(NUSD_MAX_PRICE, 18)), NUSD_MAX_PRICE);
  for (const invalid of ["", "0", "0.000", "-1", "+1", "1e3", "1,000", "NaN", "Infinity", ".5", "1.", "1.0000000000000000001", "1\n2", "0".repeat(79), formatUnits(NUSD_MAX_PRICE + 1n, 18)]) {
    assert.equal(parseNusdPrice(invalid), undefined, invalid);
  }
});

test("marketplace credits fund purchases first and approval is only the exact shortfall", () => {
  assert.deepEqual(nusdFunding(100n * UNIT, 0n), { creditUsed: 0n, walletPayment: 100n * UNIT });
  assert.deepEqual(nusdFunding(100n * UNIT, 40n * UNIT), { creditUsed: 40n * UNIT, walletPayment: 60n * UNIT });
  assert.deepEqual(nusdFunding(100n * UNIT, 150n * UNIT), { creditUsed: 100n * UNIT, walletPayment: 0n });
  for (const [price, credit] of [[0n, 0n], [-1n, 0n], [NUSD_MAX_PRICE + 1n, 0n], [1n, -1n]]) assert.throws(() => nusdFunding(price, credit));
});

test("only explicit valid nonzero deployment addresses activate the NUSD market", () => {
  assert.equal(nusdMarketplaceAddress(` ${MARKET} `), MARKET);
  for (const value of [undefined, "", "not-a-contract", "0x11", zeroAddress]) assert.equal(nusdMarketplaceAddress(value), undefined);
});

test("offer deadlines use the chain clock and reject fractional or excessive duration", () => {
  assert.equal(offerExpiry(1000n, "72"), 260200n);
  assert.equal(offerExpiry(1000n, "720"), 2593000n);
  for (const value of ["0", "721", "-1", "1.5", "1e2", "Infinity", "9999", ""]) assert.throws(() => offerExpiry(1000n, value));
  assert.throws(() => offerExpiry(-1n, "1"));
  assert.throws(() => offerExpiry((1n << 64n) - 1n, "1"));
});

test("fresh-state gate rejects stale blocks but allows withdrawals and refunds during pause", () => {
  const now = 1000000;
  const state = { readAt: now, timestamp: 1000n, paused: false };
  requireFreshNusdMarket(state, true, now);
  requireFreshNusdMarket({ ...state, paused: true }, false, now);
  assert.throws(() => requireFreshNusdMarket({ ...state, paused: true }, true, now), /paused/);
  for (const bad of [{ ...state, readAt: now - 60001 }, { ...state, readAt: now + 1 }, { ...state, timestamp: 879n }, { ...state, timestamp: 1121n }, { ...state, readAt: NaN }]) assert.throws(() => requireFreshNusdMarket(bad, false, now), /stale/);
  assert.throws(() => requireFreshNusdMarket(state, true, NaN), /stale/);
});

function reader(options: { chainId?: number; token?: Address; implementation?: string; oversized?: boolean; feeBps?: number; burned?: boolean; pendingBlock?: boolean; catalogueCount?: number; duplicate?: boolean } = {}) {
  const calls: { address: Address; functionName: string; args?: readonly unknown[]; blockNumber?: bigint }[] = [];
  const values: Record<string, unknown> = {
    nusd: options.token ?? NUSD, IMPLEMENTATION_ID: options.implementation ?? NUSD_MARKET_IMPLEMENTATION,
    paused: false, platformFeeBps: options.feeBps ?? 40, activeListingCount: BigInt(options.catalogueCount ?? 30), activeOfferCount: 25n,
    totalVolumeNusd: 500n * UNIT, escrowedNusd: 20n * UNIT, credits: 10n * UNIT, balanceOf: 90n * UNIT,
    getActiveListings: options.oversized ? Array.from({ length: NUSD_MARKET_PAGE_SIZE + 1 }, (_, index) => BigInt(index + 1)) : [1n],
    getActiveOffers: [2n], listings: [NFT, 3n, 100n * UNIT, SELLER, true],
    offers: [NFT, 3n, ACCOUNT, 80n * UNIT, 2000n, true], ownerOf: SELLER,
  };
  const client = {
    getChainId: async () => options.chainId ?? 4441,
    getBlock: async () => ({ number: options.pendingBlock ? null : 900n, timestamp: 1000n }),
    readContract: async (request: typeof calls[number]) => {
      calls.push(request);
      if (request.functionName === "getActiveListings" && options.catalogueCount !== undefined) {
        const offset = Number(request.args?.[0]);
        return Array.from({ length: Math.max(0, Math.min(24, options.catalogueCount - offset)) }, (_, index) => BigInt((options.duplicate ? 0 : offset) + index + 1));
      }
      if (request.functionName === "ownerOf" && options.burned) throw new Error("NFT burned");
      if (!Object.hasOwn(values, request.functionName)) throw new Error(`Unexpected read: ${request.functionName}`);
      return values[request.functionName];
    },
  } as unknown as Parameters<typeof readNusdMarket>[0];
  return { client, calls };
}

test("market reads bind to chain, token, implementation and one mined block with bounded pagination", async () => {
  const harness = reader();
  const state = await readNusdMarket(harness.client, MARKET, NUSD, ACCOUNT, 1);
  assert.equal(state.credit, 10n * UNIT);
  assert.equal(state.balance, 90n * UNIT);
  assert.equal(state.listings[0].price, 100n * UNIT);
  assert.equal(state.offers[0].owner, SELLER);
  assert.equal(state.blockNumber, 900n);
  assert.ok(harness.calls.every((call) => call.blockNumber === 900n));
  for (const call of harness.calls.filter((call) => call.functionName.startsWith("getActive"))) assert.deepEqual(call.args, [24n, 24n]);
  assert.equal(harness.calls.find((call) => call.functionName === "balanceOf")?.address, NUSD);
});

test("a pinned full catalogue spans bounded pages, while large markets explicitly fall back", async () => {
  const complete = reader({ catalogueCount: 30 });
  const state = await readNusdMarket(complete.client, MARKET, NUSD, ACCOUNT, 1, true);
  assert.equal(state.catalogueComplete, true);
  assert.equal(state.listings.length, 30);
  assert.deepEqual(complete.calls.filter((call) => call.functionName === "getActiveListings").map((call) => Array.from(call.args!)), [[0n, 24n], [24n, 24n]]);
  assert.ok(complete.calls.every((call) => call.blockNumber === 900n));
  const fallback = reader({ catalogueCount: 1001 });
  const page = await readNusdMarket(fallback.client, MARKET, NUSD, ACCOUNT, 1, true);
  assert.equal(page.catalogueComplete, false);
  assert.equal(page.listings.length, 24);
  assert.equal(page.listings[0].id, 25n);
  const duplicate = reader({ catalogueCount: 30, duplicate: true });
  await assert.rejects(readNusdMarket(duplicate.client, MARKET, NUSD, ACCOUNT, 0, true), /Incomplete/);
  assert.ok(!duplicate.calls.some((call) => call.functionName === "listings"));
});

test("unconfigured identities never proceed to balances or listings", async () => {
  for (const options of [{ chainId: 1 }, { pendingBlock: true }, { token: NFT }, { implementation: `0x${"00".repeat(32)}` }]) {
    const harness = reader(options);
    await assert.rejects(readNusdMarket(harness.client, MARKET, NUSD, ACCOUNT));
    assert.ok(harness.calls.every((call) => ["nusd", "IMPLEMENTATION_ID"].includes(call.functionName)));
  }
  for (const page of [-1, 0.5, NaN, Number.MAX_SAFE_INTEGER + 1]) {
    const harness = reader();
    await assert.rejects(readNusdMarket(harness.client, MARKET, NUSD, ACCOUNT, page), /page/);
    assert.equal(harness.calls.length, 0);
  }
});

test("unexpected fee or oversized response fails before per-NFT requests", async () => {
  for (const options of [{ feeBps: 501 }, { oversized: true }]) {
    const harness = reader(options);
    await assert.rejects(readNusdMarket(harness.client, MARKET, NUSD, ACCOUNT), /fee or page/);
    assert.ok(harness.calls.every((call) => !["listings", "offers", "ownerOf"].includes(call.functionName)));
  }
});

test("disconnected visitors never query wallet balances and burned NFT offers remain refundable", async () => {
  const harness = reader({ burned: true });
  const state = await readNusdMarket(harness.client, MARKET, NUSD, undefined);
  assert.equal(state.credit, 0n);
  assert.equal(state.balance, 0n);
  assert.equal(state.offers[0].owner, undefined);
  assert.ok(!harness.calls.some((call) => ["credits", "balanceOf"].includes(call.functionName)));
});

test("NUSD trade ABI cannot send native zkLTC and signs price, shortfall and seller minimum", () => {
  const functions = NusdMarketplaceAbi.filter((entry) => entry.type === "function");
  for (const entry of functions) assert.notEqual(entry.stateMutability, "payable");
  for (const [name, inputs] of [["buy", ["listingId", "expectedPrice", "maxWalletPayment"]], ["makeOffer", ["collection", "tokenId", "price", "expiresAt", "maxWalletPayment"]], ["acceptOffer", ["offerId", "minimumSellerProceeds"]]] as const) {
    assert.deepEqual(functions.find((entry) => entry.name === name)?.inputs.map((input) => input.name), inputs);
  }
});
