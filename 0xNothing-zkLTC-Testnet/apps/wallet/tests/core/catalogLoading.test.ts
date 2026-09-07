import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

type Catalog = { entries: string[]; changes24h: Record<string, number>; degraded: boolean };

function fixture() {
  const file = new URL("../../src/core/services/marketCatalog.ts", import.meta.url);
  const source = ts.createSourceFile(file.pathname, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
  const fn = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "fetchCatalog");
  assert.ok(fn);
  const code = ts.transpileModule(`${fn.getText(source)}\nfetchCatalog;`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const pumpApi = deferred<string[]>();
  const fiApi = deferred<{ entries: string[]; changes24h: Record<string, number> }>();
  const pumpGraph = deferred<string[]>();
  const fiGraph = deferred<{ entries: string[]; changes24h: Record<string, number> }>();
  const fiGraphStarted = deferred<void>();
  const calls: string[] = [];
  const load = runInNewContext(code, {
    PUBLIC_APP_URL: "https://app.invalid", MAX_PUMP_TOKENS: 200, publicClient: {},
    boundedJson: (url: string) => { calls.push(url.includes("/api/pump") ? "pump-api" : "fi-api"); return url.includes("/api/pump") ? pumpApi.promise : fiApi.promise; },
    parsePumpCatalog: (value: unknown) => value,
    parseFiCatalog: (value: unknown) => value,
    pumpCatalogFromGraph: () => { calls.push("pump-graph"); return pumpGraph.promise; },
    fiCatalogFromGraph: () => { calls.push("fi-graph"); fiGraphStarted.resolve(); return fiGraph.promise; },
    pumpCatalogOnChain: async () => { calls.push("pump-chain"); return ["pump-chain"]; },
    fiCatalogOnChain: async () => { calls.push("fi-chain"); return ["fi-chain"]; },
    mergeEntries: (groups: string[][]) => [...new Set(groups.flat())],
  }) as (network: { builtin: boolean }) => Promise<Catalog>;
  return { load, pumpApi, fiApi, pumpGraph, fiGraph, fiGraphStarted, calls };
}

test("0xFi fallback starts while the Pump API is still pending", { timeout: 2_000 }, async () => {
  const f = fixture();
  const result = f.load({ builtin: true });
  f.fiApi.reject(new Error("API timeout"));
  await f.fiGraphStarted.promise;
  assert.ok(!f.calls.includes("pump-graph"));
  f.fiGraph.resolve({ entries: ["fi"], changes24h: { fi: 0.1 } });
  f.pumpApi.resolve(["pump"]);
  const catalog = await result;
  assert.deepEqual(Array.from(catalog.entries), ["pump", "fi"]);
  assert.equal(catalog.degraded, false);
});

test("both sources fall back independently and retain on-chain degradation flags", { timeout: 2_000 }, async () => {
  const f = fixture();
  const result = f.load({ builtin: true });
  f.pumpApi.reject(new Error("API timeout"));
  f.fiApi.reject(new Error("API timeout"));
  await f.fiGraphStarted.promise;
  assert.ok(f.calls.includes("pump-graph"));
  f.fiGraph.reject(new Error("indexer timeout"));
  f.pumpGraph.reject(new Error("indexer timeout"));
  const catalog = await result;
  assert.deepEqual(Array.from(catalog.entries), ["pump-chain", "fi-chain"]);
  assert.equal(catalog.degraded, true);
  for (const source of ["pump", "fi"]) {
    assert.ok(f.calls.indexOf(`${source}-api`) < f.calls.indexOf(`${source}-graph`));
    assert.ok(f.calls.indexOf(`${source}-graph`) < f.calls.indexOf(`${source}-chain`));
  }
});

test("custom networks do not load the built-in market catalog", async () => {
  const f = fixture();
  const result = await f.load({ builtin: false });
  assert.equal(result.entries.length, 0);
  assert.equal(result.degraded, false);
  assert.equal(f.calls.length, 0);
});
