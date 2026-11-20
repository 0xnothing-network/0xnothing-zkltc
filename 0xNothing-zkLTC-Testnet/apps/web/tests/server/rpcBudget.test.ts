import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { createPublicClient, http } from "viem";
import { createRpcBudget } from "../../lib/server/rpcBudget.ts";

test("a hung RPC costs one budget, not one timeout per read", { timeout: 20_000 }, async (t) => {
  let requests = 0;
  // Deliberately never answers: the transport has to give up on its own.
  const server = createServer((request) => { request.resume(); request.on("end", () => { requests += 1; }); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve, reject) => {
    server.closeAllConnections();
    server.close((error) => error ? reject(error) : resolve());
  }));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const budget = createRpcBudget(300);
  // The same shape as the pool route's client: a 5 s timeout and one retry per read.
  const client = createPublicClient({
    transport: http(`http://127.0.0.1:${address.port}`, { retryCount: 1, timeout: 5_000, fetchFn: budget.fetch }),
  });

  budget.start();
  let started = Date.now();
  await assert.rejects(client.getBlockNumber());
  const first = Date.now() - started;
  assert.ok(first >= 250 && first < 2_500, `the read in flight is cut at the deadline (took ${first} ms)`);
  assert.equal(requests, 1, "the retry after the deadline never reaches the RPC");

  started = Date.now();
  await assert.rejects(client.getBlockNumber());
  assert.ok(Date.now() - started < 1_500, "a later read of the same load fails at once");
  assert.equal(requests, 1);
  assert.ok(budget.remainingMs() <= 0);

  budget.start();
  await assert.rejects(client.getBlockNumber());
  assert.equal(requests, 2, "the next load gets a full budget and reaches the RPC again");
});

test("requests pass through untouched before any budget starts, and keep the caller's signal after", async () => {
  const seen: RequestInit[] = [];
  const budget = createRpcBudget(1_000, async (_input, init) => { seen.push(init ?? {}); return new Response("ok"); });
  assert.equal(budget.remainingMs(), Infinity);
  assert.equal(await (await budget.fetch("http://rpc.test")).text(), "ok");
  assert.equal(seen[0].signal, undefined);

  budget.start();
  const caller = new AbortController();
  await budget.fetch("http://rpc.test", { signal: caller.signal });
  assert.equal(seen[1].signal?.aborted, false);
  caller.abort();
  assert.equal(seen[1].signal?.aborted, true, "the caller's own abort still reaches the request");
});
