import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { createPublicClient, http } from "viem";
import { evaluateModule } from "../helpers/evaluateModule.ts";

test("a stalled optional log request aborts without batching or repeated retries", { timeout: 15_000 }, async (t) => {
  const requests: unknown[] = [];
  const server = createServer((request) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => { body += chunk; });
    request.on("end", () => { requests.push(JSON.parse(body)); });
    // Deliberately leave the response open: the real HTTP transport must abort.
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve, reject) => {
    server.closeAllConnections();
    server.close((error) => error ? reject(error) : resolve());
  }));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const { liveLogClient } = evaluateModule<{
    liveLogClient: { getLogs(args: { fromBlock: bigint; toBlock: bigint }): Promise<unknown> };
  }>(new URL("../../features/fi/lib/server/liveLogClient.ts", import.meta.url), {
    "server-only": {},
    viem: { createPublicClient, http },
    "@fi/config/deployment": { deployment: { chain: { rpcUrl: `http://127.0.0.1:${address.port}` } } },
  });
  await assert.rejects(liveLogClient.getLogs({ fromBlock: 1n, toBlock: 1n }), /too long|timed out/i);
  assert.equal(requests.length, 1);
  assert.equal(Array.isArray(requests[0]), false);
  assert.equal((requests[0] as { method: string }).method, "eth_getLogs");
});
