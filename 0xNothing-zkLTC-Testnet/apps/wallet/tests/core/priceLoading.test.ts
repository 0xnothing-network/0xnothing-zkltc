import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import * as viem from "viem";

const wad = 10n ** 18n;
const token = { id: "pump", address: "0xtoken", decimals: 18, priceSource: "pool" };
const native = { id: "native", decimals: 18, priceSource: "oracle" };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function fixture(lifecycle = 3) {
  const adapter = deferred<string>();
  const reservesStarted = deferred<void>();
  const calls: string[] = [];
  const success = (result: unknown) => ({ status: "success", result });
  const client = {
    readContract: async ({ functionName }: { functionName: string }) => {
      calls.push(functionName);
      return functionName === "getPair" ? "0xpair" : token.address;
    },
    multicall: async ({ contracts }: { contracts: { functionName: string }[] }) => {
      const name = contracts[0]?.functionName;
      assert.ok(name);
      calls.push(name);
      if (name === "getReserves") {
        reservesStarted.resolve();
        return [success([2n * wad, 10n * wad, 0])];
      }
      if (name === "status") return [success(lifecycle), success(7n * wad)];
      return [success([100n * wad, 1n]), success(true)];
    },
  };
  const imports: Record<string, unknown> = {
    viem,
    "../../abis": {},
    "../../config/contracts": { CONTRACTS: { nusd: "0xnusd", dexFactory: "0xfactory", pumpFactory: "0xpump" } },
    "../lib/format": { WAD: wad },
    "../rpc/client": { activeNetwork: { id: "test", rpcUrl: "https://rpc.invalid", builtin: true }, publicClient: client },
    "./nusdOracle": { nusdOracleAddress: () => adapter.promise },
  };
  const file = new URL("../../src/core/services/prices.ts", import.meta.url);
  const code = ts.transpileModule(readFileSync(file, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports = {} as { loadPrices(tokens: unknown[]): Promise<Map<string, { priceWad: bigint; stale: boolean }>> };
  runInNewContext(code, { exports, require: (name: string) => {
    assert.ok(Object.hasOwn(imports, name), name);
    return imports[name];
  } });
  return { ...exports, adapter, calls, reservesStarted };
}

test("DEX reserves load while the oracle lookup is still pending; duplicate loads coalesce", { timeout: 2_000 }, async () => {
  const f = fixture();
  const result = f.loadPrices([native, token]);
  assert.equal(f.loadPrices([native, token]), result);
  await f.reservesStarted.promise;
  assert.ok(!f.calls.includes("readPriceWad"));
  f.adapter.resolve("0xoracle");
  const prices = await result;
  assert.equal(prices.get("pump")?.priceWad, 5n * wad);
  assert.equal(prices.get("native")?.priceWad, 100n * wad);
  assert.equal(prices.get("native")?.stale, false);
  assert.equal(f.calls.filter((name) => name === "getReserves").length, 1);
});

test("active Pump price still overrides the DEX price after concurrent reads", async () => {
  const f = fixture(1);
  f.adapter.resolve("0xoracle");
  assert.equal((await f.loadPrices([native, token])).get("pump")?.priceWad, 7n * wad);
});

test("oracle failure rejects the read even when the DEX branch already succeeded", async () => {
  const f = fixture();
  const result = f.loadPrices([native, token]);
  const rejected = assert.rejects(result, /oracle offline/);
  await f.reservesStarted.promise;
  f.adapter.reject(new Error("oracle offline"));
  await rejected;
});

/** Only a pool-priced import: no oracle leg, so the adapter is never asked. */
function unpricedFixture(pair: () => Promise<string>, status: () => unknown) {
  const client = {
    readContract: async ({ functionName }: { functionName: string }) =>
      functionName === "getPair" ? pair() : token.address,
    multicall: async () => [status(), { status: "failure", error: new Error("no spot") }],
  };
  const imports: Record<string, unknown> = {
    viem,
    "../../abis": {},
    "../../config/contracts": { CONTRACTS: { nusd: "0xnusd", dexFactory: "0xfactory", pumpFactory: "0xpump" } },
    "../lib/format": { WAD: wad },
    "../rpc/client": { activeNetwork: { id: "test", rpcUrl: "https://rpc.invalid", builtin: true }, publicClient: client },
    "./nusdOracle": { nusdOracleAddress: async () => null },
  };
  const file = new URL("../../src/core/services/prices.ts", import.meta.url);
  const code = ts.transpileModule(readFileSync(file, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports = {} as { loadPrices(tokens: unknown[]): Promise<Map<string, { priceWad: bigint; source: string; stale: boolean }>> };
  runInNewContext(code, { exports, require: (name: string) => imports[name] });
  return exports;
}

const ZERO = "0x0000000000000000000000000000000000000000";
const marketNotFound = () => ({
  status: "failure",
  error: new viem.ContractFunctionRevertedError({ abi: [], data: "0x7db1be50", functionName: "status" }),
});

test("a token with no NUSD pair and no Pump market is settled as unpriced, not stale", async () => {
  const price = (await unpricedFixture(async () => ZERO, marketNotFound).loadPrices([token])).get("pump");
  // Built in another realm, so compared field by field.
  assert.deepEqual([price?.priceWad, price?.source, price?.stale], [0n, "none", false]);
  const notLaunched = unpricedFixture(async () => ZERO, () => ({ status: "success", result: 0 }));
  assert.equal((await notLaunched.loadPrices([token])).get("pump")?.stale, false);
});

test("a failed read is never taken for a missing price", async () => {
  // The pair lookup itself failed.
  const pairDown = unpricedFixture(async () => { throw new Error("rpc down"); }, marketNotFound);
  assert.equal((await pairDown.loadPrices([token])).get("pump")?.stale, true);
  // The factory said no pair, but the Pump answer was lost.
  const pumpDown = unpricedFixture(async () => ZERO, () => ({ status: "failure", error: new Error("HTTP request failed.") }));
  assert.equal((await pumpDown.loadPrices([token])).get("pump")?.stale, true);
  // A live curve with no spot price yet is not "no market".
  const trading = unpricedFixture(async () => ZERO, () => ({ status: "success", result: 1 }));
  assert.equal((await trading.loadPrices([token])).get("pump")?.stale, true);
});
