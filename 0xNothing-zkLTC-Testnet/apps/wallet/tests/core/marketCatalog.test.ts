import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { isAddress } from "viem";
import { weightedPortfolioChange24h } from "../../src/core/lib/portfolioChange.ts";

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

const NUSD = "0x9999999999999999999999999999999999999999";
const WZKLTC = "0x2222222222222222222222222222222222222222";
const NBTC = "0x3333333333333333333333333333333333333333";

/** Lifts named functions out of marketCatalog.ts, with their module-level names supplied. */
function catalogFunctions<T>(names: readonly string[], globals: Record<string, unknown>): T {
  const file = new URL("../../src/core/services/marketCatalog.ts", import.meta.url);
  const source = ts.createSourceFile(file.pathname, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
  const text = names.map((name) => {
    const fn = source.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === name);
    assert.ok(fn, name);
    return fn.getText(source).replace(/^export /u, "");
  }).join("\n");
  const code = ts.transpileModule(`${text}\n({ ${names.join(", ")} });`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return runInNewContext(code, globals) as T;
}

function pool(token0: string, token1: string, priceChange24h: number) {
  return { token0: { id: token0 }, token1: { id: token1 }, priceChange24h };
}

test("a pool books a 24h move only when NUSD is exactly one side", () => {
  const { parseFiCatalog } = catalogFunctions<{
    parseFiCatalog(payload: unknown): { changes24h: Record<string, number> };
  }>(["parseFiCatalog"], {
    CONTRACTS: { nusd: NUSD },
    MAX_DEX_PAIRS: 100,
    isAddress,
    record: (value: unknown) => value && typeof value === "object" ? value : null,
    hasLiquidity: () => true,
    candidateToken: () => null,
  });
  const { changes24h } = parseFiCatalog({
    data: [pool(NUSD, WZKLTC, 8), pool(NBTC, WZKLTC, 40), pool(MARKET_TOKEN.id, NUSD, -5)],
  });
  assert.equal(changes24h[WZKLTC], 0.08);
  // nBTC/WzkLTC has no NUSD side: it moves neither token.
  assert.equal(changes24h[NBTC], undefined);
  assert.equal(changes24h[MARKET_TOKEN.id], -0.05);
});

test("a feed-priced zkLTC wallet never shows the WzkLTC pool's 24h move", async () => {
  const { loadPortfolioMarketChange24h } = catalogFunctions<{
    loadPortfolioMarketChange24h(portfolio: unknown, network: unknown): Promise<number | null>;
  }>(["loadPortfolioMarketChange24h"], {
    CONTRACTS: { nusd: NUSD, wzkltc: WZKLTC },
    NUSD_TOKEN: { id: NUSD },
    MAX_CANDLE_TOKENS: 8,
    // The thin pool moved 8% while the feed was flat.
    loadSwapCatalog: async () => ({ entries: [], changes24h: { [WZKLTC]: 0.08, [MARKET_TOKEN.id]: 0.1 } }),
    pumpCandleChange: async () => null,
    weightedPortfolioChange24h,
  });
  const native = { id: "native", priceSource: "oracle" };
  const wrapped = { id: WZKLTC, address: WZKLTC, priceSource: "oracle" };
  const only = (token: object) => ({ rows: [{ token, valueWad: 100n * WAD }], suppliedNusd: 0n });
  assert.equal(await loadPortfolioMarketChange24h(only(native), { builtin: true }), null);
  assert.equal(await loadPortfolioMarketChange24h(only(wrapped), { builtin: true }), null);
  // A pool-priced token still takes its pool's move.
  const market = { ...MARKET_TOKEN, priceSource: "pool" };
  const pooled = await loadPortfolioMarketChange24h(
    { rows: [{ token: market, valueWad: 100n * WAD }], suppliedNusd: 0n },
    { builtin: true },
  );
  assert.equal(pooled, 0.1);
});
