import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { fetchJson } from "../../lib/http.ts";

test("stalled headers and stalled JSON bodies time out, then the next live request recovers", async () => {
  const server = createServer((req, res) => {
    if (req.url === "/headers") return;
    if (req.url === "/body") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.write('{"value":');
      return;
    }
    res.setHeader("Content-Type", "application/json");
    res.end('{"value":2}');
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  try {
    for (const path of ["/headers", "/body"]) {
      await assert.rejects(fetchJson(`${base}${path}`, undefined, "Live data", 150), { name: "TimeoutError" });
      assert.deepEqual(await fetchJson(base), { value: 2 });
    }
    const controller = new AbortController();
    const pending = fetchJson(`${base}/body`, { signal: controller.signal });
    controller.abort();
    await assert.rejects(pending, { name: "AbortError" });
    const request = new Request(`${base}/headers`, { signal: controller.signal });
    await assert.rejects(fetchJson(request), { name: "AbortError" });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("JSON reads retain API errors and reject malformed successful responses", async () => {
  const server = createServer((req, res) => {
    if (req.url === "/error") {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end('{"error":"Indexer unavailable"}');
    } else {
      res.end("not JSON");
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  try {
    await assert.rejects(fetchJson(`${base}/error`), /Indexer unavailable/);
    await assert.rejects(fetchJson(base), /invalid JSON response/);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
