import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const owner = "0x00000000000000000000000000000000000000aa";
const native = { id: "native", symbol: "zkLTC", decimals: 18, builtin: true, pinned: true };
const good = { id: "good", address: "0xgood", symbol: "GOOD", decimals: 18, builtin: false };
const bad = { id: "bad", address: "0xbad", symbol: "BAD", decimals: 18, builtin: false };

type Row = { token: { id: string }; balance: bigint; readError: string | null };
interface PortfolioModule {
  loadPortfolio(address: string, tokens: unknown[]): Promise<{ rows: Row[]; complete: boolean }>;
  rowBalance(rows: Row[] | undefined, tokenId: string): bigint | null;
  rowReadError(rows: Row[] | undefined, tokenId: string): string | null;
}

function load(failing: (address: string) => boolean): PortfolioModule {
  const client = {
    getBalance: async () => 5n,
    getBlockNumber: async () => 7n,
    multicall: async ({ contracts }: { contracts: { address: string }[] }) => contracts.map((call) =>
      failing(call.address)
        ? { status: "failure", error: new Error(`revert ${call.address}`) }
        : { status: "success", result: 3n }),
  };
  const imports: Record<string, unknown> = {
    "../../abis": { erc20Abi: [], lendingPoolAbi: [] },
    "../../config/networks": { networkIdentity: () => "test" },
    "../../config/contracts": { CONTRACTS: { lendingPool: "0xpool" } },
    "../lib/errors": { describeError: (error: Error) => error.message },
    "../lib/format": { usdValueWad: () => 0n },
    "../platform/storage": { persistentStore: {} },
    "../platform/storageKeys": { STORAGE_KEYS: {} },
    "../platform/locks": { withNamedLock: () => undefined },
    "../rpc/blockTicker": { latestBlock: () => 7n },
    "../rpc/client": {
      activeNetwork: { id: "test", rpcUrl: "https://rpc.invalid", builtin: true },
      publicClient: client,
    },
    "./prices": { loadPrices: async () => new Map() },
  };
  const file = new URL("../../src/core/services/portfolio.ts", import.meta.url);
  const code = ts.transpileModule(readFileSync(file, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports = {} as PortfolioModule;
  runInNewContext(code, { exports, require: (name: string) => {
    assert.ok(Object.hasOwn(imports, name), name);
    return imports[name];
  } });
  return exports;
}

test("one unreadable token keeps every other row and reads as unknown, not 0", async () => {
  const portfolio = load((address) => address === bad.address);
  const result = await portfolio.loadPortfolio(owner, [native, good, bad]);
  assert.equal(result.rows.length, 3);
  assert.equal(result.complete, false);
  assert.equal(portfolio.rowBalance(result.rows, native.id), 5n);
  assert.equal(portfolio.rowBalance(result.rows, good.id), 3n);
  assert.equal(portfolio.rowReadError(result.rows, bad.id), "revert 0xbad");
  assert.equal(portfolio.rowReadError(result.rows, good.id), null);
  assert.equal(portfolio.rowBalance(result.rows, bad.id), null);
  assert.equal(portfolio.rowBalance(result.rows, "missing"), null);
});

test("every balance leg down still rejects so the last good snapshot stays", async () => {
  const portfolio = load(() => true);
  await assert.rejects(portfolio.loadPortfolio(owner, [native, good, bad]), /revert/u);
});
