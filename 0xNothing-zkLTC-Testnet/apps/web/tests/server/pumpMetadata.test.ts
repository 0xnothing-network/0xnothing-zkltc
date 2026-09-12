import assert from "node:assert/strict";
import test from "node:test";
import { createBoundedCache } from "../../lib/boundedCache.ts";
import { readLimitedBytes } from "../../lib/server/readLimitedBytes.ts";
import { evaluateModule } from "../helpers/evaluateModule.ts";

const config = evaluateModule<{ normalizePumpIpfsPath: (value: string) => string }>(
  new URL("../../features/pump/config.ts", import.meta.url), { "@/lib/publicConfig": {} },
);
const cid = "bafkreig3eedskjp45hcwf47bhfcwxtlw5fayiwmxcc472hvysunyhy2dqy";
function harness(fetcher: (url: string, options: RequestInit) => Promise<Response>) {
  const route = evaluateModule<{ GET: (request: Request) => Promise<Response> }>(
    new URL("../../app/api/pump/metadata/route.ts", import.meta.url),
    { "@/features/pump/config": config, "@/lib/boundedCache": { createBoundedCache }, "@/lib/server/readLimitedBytes": { readLimitedBytes } },
    { Response, URL, TextDecoder, AbortController, setTimeout, clearTimeout, fetch: fetcher },
  );
  return (value = cid) => route.GET(new Request(`https://app.test/api/pump/metadata?cid=${encodeURIComponent(value)}`));
}

test("metadata rejects arbitrary destinations and traversal without fetching", async () => {
  const get = harness(async () => { throw new Error("must not fetch"); });
  for (const value of ["https://127.0.0.1", `${cid}/../secret`, `${cid}/%2e%2e`, ""]) {
    assert.equal((await get(value)).status, 400);
  }
});

test("metadata hedges a failed gateway, strips unused data and caches concurrent requests", async () => {
  const calls: string[] = [];
  const get = harness(async (url, options) => {
    calls.push(url);
    assert.equal(options.redirect, "error");
    if (url.includes("pinata")) return new Response("Forbidden", { status: 403 });
    return Response.json({ description: "Token", external_url: "https://example.org", ignored: "data", properties: { twitter: "https://x.com/test" } });
  });
  const [a, b] = await Promise.all([get(), get()]);
  assert.equal(a.headers.get("X-Pump-Metadata-Status"), "available");
  assert.deepEqual(await a.json(), await b.json());
  assert.equal(calls.length, 2);
  assert.equal((await (await get()).json()).ignored, undefined);
  assert.equal(calls.length, 2);
});

test("failed and oversized metadata is negatively cached without retry storms", async () => {
  let calls = 0;
  const get = harness(async () => { calls++; return new Response('x'.repeat(65 * 1024)); });
  const first = await get();
  assert.equal(first.headers.get("X-Pump-Metadata-Status"), "unavailable");
  assert.deepEqual(await first.json(), {});
  await get();
  assert.equal(calls, 2);
});
