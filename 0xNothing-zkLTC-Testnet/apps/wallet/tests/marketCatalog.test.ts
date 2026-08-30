import assert from "node:assert/strict";
import { test } from "node:test";
import { weightedPortfolioChange24h } from "../src/core/lib/portfolioChange.ts";

const WAD = 10n ** 18n;
const NUSD_TOKEN = {
  id: "0x9999999999999999999999999999999999999999",
};
const MARKET_TOKEN = {
  id: "0x1111111111111111111111111111111111111111",
  address: "0x1111111111111111111111111111111111111111",
};

function row(token: { id: string; address?: string }, valueWad: bigint) {
  return {
    token,
    valueWad,
  };
}

test("24h portfolio move weights stable and market-priced holdings", () => {
  const change = weightedPortfolioChange24h(
    [row(NUSD_TOKEN, 50n * WAD), row(MARKET_TOKEN, 50n * WAD)],
    0n,
    { [NUSD_TOKEN.id]: 0, [MARKET_TOKEN.id]: 0.1 },
  );
  assert.equal(change, 0.0476);
});

test("24h portfolio move requires broad coverage and counts supplied NUSD", () => {
  assert.equal(
    weightedPortfolioChange24h(
      [row(NUSD_TOKEN, 50n * WAD), row(MARKET_TOKEN, 100n * WAD)],
      0n,
      { [NUSD_TOKEN.id]: 0 },
    ),
    null,
  );
  assert.equal(
    weightedPortfolioChange24h([row(MARKET_TOKEN, 20n * WAD)], 80n * WAD, {}),
    0,
  );
});
