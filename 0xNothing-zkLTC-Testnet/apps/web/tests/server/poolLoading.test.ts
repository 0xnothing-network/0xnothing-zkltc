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

interface Envelope {
  data: unknown[];
  meta: { source: string; indexedBlock: number; rpcTail: { status?: string } };
  warning?: string;
}

// Exercise the actual orchestration function with independently delayed I/O.
// Its route-local RPC helpers are boundaries here, not copies of the pipeline.
function fixture(options: { unconfigured?: boolean; failFirstDiscovery?: boolean; tailUnavailable?: boolean } = {}) {
  const file = new URL("../../app/0xFi/api/data/pools/route.ts", import.meta.url);
  const source = ts.createSourceFile(file.pathname, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
  const fn = source.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === "loadPoolsEnvelope");
  assert.ok(fn);
  const code = ts.transpileModule(`${fn.getText(source)}\nloadPoolsEnvelope;`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const pools = deferred<Envelope>();
  const candles = deferred<{ data: unknown[] }>();
  const oracle = deferred<{ snapshots: Map<string, unknown>; failed: number }>();
  const calls: string[] = [];
  const load = runInNewContext(code, {
    QUERY: "pools",
    CANDLES_24H_QUERY: "candles",
    queryGoldsky: (query: string) => { calls.push(query); return query === "pools" ? pools.promise : candles.promise; },
    loadCanonicalOracleSnapshots: () => { calls.push("oracle"); return oracle.promise; },
    asPoolPoint: (value: unknown) => value,
    refreshPools: async () => { calls.push("reserves"); return { failedPools: 0, totalPools: 0 }; },
    loadRpcTail: async () => {
      calls.push("tail");
      if (options.tailUnavailable) throw new Error("log timeout");
      return { pools: [], fromBlock: 2n, toBlock: 2n, capped: options.unconfigured ?? false };
    },
    loadFactoryPools: async () => {
      calls.push("discovery");
      if (options.failFirstDiscovery && calls.filter((name) => name === "discovery").length === 1) {
        throw new Error("temporary discovery failure");
      }
      return [];
    },
    visibleDeploymentPools: async (rows: unknown[]) => ({ pools: rows, communityPoolIds: new Set() }),
    enrichPumpTokenImages: async () => { calls.push("pump-images"); },
    enrichRegistryImages: async () => { calls.push("registry-images"); },
    enrichLockBurnBadges: async () => {},
    deployment: { contracts: {} },
    console: { warn() {} },
  }) as () => Promise<Envelope>;
  const resolvePools = () => pools.resolve({ data: [], meta: { source: options.unconfigured ? "unconfigured" : "goldsky", indexedBlock: 1, rpcTail: {} } });
  return { load, resolvePools, candles, oracle, calls };
}

test("pool API starts market reads before discovery completes and preserves enrichment order", async () => {
  const f = fixture();
  const result = f.load();
  assert.deepEqual([...f.calls].sort(), ["candles", "oracle", "pools"]);
  f.candles.resolve({ data: [] });
  f.oracle.resolve({ snapshots: new Map(), failed: 0 });
  f.resolvePools();
  const envelope = await result;
  assert.equal(envelope.meta.rpcTail.status, "merged");
  assert.ok(f.calls.indexOf("reserves") < f.calls.indexOf("tail"));
  assert.ok(f.calls.indexOf("pump-images") < f.calls.indexOf("registry-images"));
});

test("an early optional candle failure does not discard the pool response", async () => {
  const f = fixture();
  const result = f.load();
  f.candles.reject(new Error("indexer offline"));
  await new Promise((resolve) => setImmediate(resolve));
  f.oracle.resolve({ snapshots: new Map(), failed: 1 });
  f.resolvePools();
  assert.match((await result).warning ?? "", /DIA price is unavailable/);
});

test("an early oracle failure remains observed and rejects when the pool branch settles", async () => {
  const f = fixture();
  const result = f.load();
  const rejected = assert.rejects(result, /oracle offline/);
  f.oracle.reject(new Error("oracle offline"));
  await new Promise((resolve) => setImmediate(resolve));
  f.candles.resolve({ data: [] });
  f.resolvePools();
  await rejected;
});

test("unavailable indexer plus capped tail scans the factory once per response", async () => {
  const f = fixture({ unconfigured: true });
  const result = f.load();
  f.resolvePools();
  f.candles.resolve({ data: [] });
  f.oracle.resolve({ snapshots: new Map(), failed: 0 });
  assert.equal((await result).meta.rpcTail.status, "capped");
  assert.equal(f.calls.filter((name) => name === "discovery").length, 1);
});

test("a failed factory scan can still retry during capped-tail recovery", async () => {
  const f = fixture({ unconfigured: true, failFirstDiscovery: true });
  const result = f.load();
  f.resolvePools();
  f.candles.resolve({ data: [] });
  f.oracle.resolve({ snapshots: new Map(), failed: 0 });
  const envelope = await result;
  assert.equal(envelope.meta.rpcTail.status, "capped");
  assert.match(envelope.warning ?? "", /Factory discovery is temporarily unavailable/);
  assert.equal(f.calls.filter((name) => name === "discovery").length, 2);
});

test("a log timeout returns the indexed response with an unavailable-tail warning", async () => {
  const f = fixture({ tailUnavailable: true });
  const result = f.load();
  f.resolvePools();
  f.candles.resolve({ data: [] });
  f.oracle.resolve({ snapshots: new Map(), failed: 0 });
  const envelope = await result;
  assert.equal(envelope.meta.source, "goldsky");
  assert.equal(envelope.meta.rpcTail.status, "unavailable");
  assert.match(envelope.warning ?? "", /RPC tail is temporarily unavailable/);
});
