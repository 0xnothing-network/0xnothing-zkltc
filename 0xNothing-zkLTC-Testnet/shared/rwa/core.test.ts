import assert from "node:assert/strict";
import test from "node:test";
import { decodeQuote, parseRwaAmount, readRwaState, tradeLimit, validateMarkets, type RwaMarketConfig, type RwaRead } from "./core.ts";

const market = {
  chainId: 4441, market: `0x${"11".repeat(20)}`, asset: `0x${"22".repeat(20)}`, settlement: `0x${"33".repeat(20)}`,
  assetSymbol: "RWA", settlementSymbol: "NUSD", assetDecimals: 8, settlementDecimals: 6,
  name: "Fixture market", issuer: "Test fixture only", documentationUrl: "https://example.com/asset",
  sourceUrls: [1, 2, 3, 4].map((n) => `https://example.com/feed/${n}`),
} as const;
const config = validateMarkets([{ ...market, sourceUrls: [...market.sourceUrls] }])[0] as RwaMarketConfig;
const owner = `0x${"44".repeat(20)}`;
const oracle = `0x${"55".repeat(20)}`;
const responses: Record<string, unknown> = {
  asset: config.asset, settlement: config.settlement, assetDecimals: 8, settlementDecimals: 6,
  FEE_BPS: 100n, owner, paused: false, availableLiquidity: 1000n, feeReserve: 10n, withdrawableFees: 10n,
  reserveFloor: 100n, remainingDailySell: 500n, maxTradeValue: 200n, oracle, balanceOf: 42n,
  readPriceWad: [100n * 10n ** 18n, 1000n, 1n],
};
const reader = (overrides: Record<string, unknown> = {}): RwaRead => async (_address, name) => {
  const result = { ...responses, ...overrides }[name];
  if (result instanceof Error) throw result;
  return result;
};

test("RWA catalog rejects missing issuer data, unsafe links, duplicate/cross-token addresses and bad precision", () => {
  assert.deepEqual(validateMarkets([]), []);
  for (const patch of [{ documentationUrl: "javascript:alert(1)" }, { issuer: "" }, { market: "0x0" },
    { asset: config.settlement }, { assetDecimals: 19 }, { chainId: 0 }, { sourceUrls: [] },
    { sourceUrls: Array(4).fill("http://example.com") }]) {
    assert.throws(() => validateMarkets([{ ...config, ...patch }]));
  }
  assert.throws(() => validateMarkets([config, config]));
});

test("RWA input preserves exact token units and rejects silently rounded amounts", () => {
  assert.equal(parseRwaAmount("1.00000001", 8), 100000001n);
  assert.equal(parseRwaAmount("123456789123456789.123456789123456789", 18), 123456789123456789123456789123456789n);
  for (const value of ["", "0", "-1", "1e3", "1.000000001", "NaN", ".5", "1.", "0x12"]) {
    assert.equal(parseRwaAmount(value, 8), null);
  }
  assert.equal(parseRwaAmount((2n ** 256n).toString(), 0), null);
});

test("RWA slippage limits round in the user's expected direction", () => {
  assert.equal(tradeLimit(10100n, true), 10151n);
  assert.equal(tradeLimit(9900n, false), 9850n);
  assert.throws(() => tradeLimit(1n, true, 501));
});

test("RWA quotes require the 1% fee and valid totals", () => {
  assert.deepEqual(decodeQuote([100n, 1n, 101n]), [100n, 1n, 101n]);
  assert.deepEqual(decodeQuote([100n, 1n, 99n]), [100n, 1n, 99n]);
  for (const bad of [[100n, 2n, 102n], [100n, 1n, 100n], [0n, 0n, 0n], [100, 1, 101]]) {
    assert.throws(() => decodeQuote(bad));
  }
});

test("RWA state checks deployed token identities, decimals and fee before exposing balances", async () => {
  const state = await readRwaState(reader(), config, config.asset);
  assert.equal(state.assetBalance, 42n);
  assert.equal(state.price, 100n * 10n ** 18n);
  for (const patch of [{ asset: config.settlement }, { settlementDecimals: 18 }, { FEE_BPS: 101n },
    { availableLiquidity: undefined }, { balanceOf: new Error("RPC failed") }]) {
    await assert.rejects(readRwaState(reader(patch), config, config.asset));
  }
});

test("RWA oracle failure keeps reserve visibility but never a last-known executable price", async () => {
  const state = await readRwaState(reader({ readPriceWad: new Error("stale") }), config);
  assert.equal(state.price, null);
  assert.equal(state.priceUpdatedAt, null);
  assert.equal(state.fees, 10n);
  assert.equal(state.assetBalance, 0n);
});
