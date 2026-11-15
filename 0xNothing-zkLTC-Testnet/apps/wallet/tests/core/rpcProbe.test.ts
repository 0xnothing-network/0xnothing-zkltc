import assert from "node:assert/strict";
import { test } from "node:test";
import { probeChainId } from "../../src/core/services/rpcProbe.ts";

// The wallet asks a proposed RPC for its chain id itself, once, before Approve
// is offered (F11) and again right before saving. Any failure is null.
const reply = (body: string, init: ResponseInit = {}) => async () => new Response(body, init);

test("a matching answer returns the chain id; redirects, non-ok, oversize and malformed bodies return null; never throws", async () => {
  const seen: RequestInit[] = [];
  const ok = await probeChainId("https://rpc.example/", 1_000, (async (_url: unknown, init?: RequestInit) => {
    seen.push(init ?? {});
    return new Response('{"jsonrpc":"2.0","id":1,"result":"0x2105"}');
  }) as typeof fetch);
  assert.equal(ok, 8453n);
  // No cookies, no referrer, no cache, and a redirect is an error, not followed.
  assert.equal(seen[0]!.credentials, "omit");
  assert.equal(seen[0]!.redirect, "error");
  assert.equal(seen[0]!.referrerPolicy, "no-referrer");
  assert.equal(seen[0]!.cache, "no-store");
  assert.equal(seen[0]!.body, '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}');

  const cases: Array<[string, typeof fetch]> = [
    ["non-ok", reply('{"result":"0x2105"}', { status: 500 }) as typeof fetch],
    ["not json", reply("<html>") as typeof fetch],
    ["error object", reply('{"error":{"code":-32601}}') as typeof fetch],
    ["decimal result", reply('{"result":"8453"}') as typeof fetch],
    ["too long", reply(`{"result":"0x${"1".repeat(17)}"}`) as typeof fetch],
    ["null body", reply("null") as typeof fetch],
    ["oversize", reply(`{"result":"0x2105","pad":"${"x".repeat(70_000)}"}`) as typeof fetch],
    ["throws", (async () => { throw new TypeError("Failed to fetch"); }) as typeof fetch],
  ];
  for (const [name, fetcher] of cases) {
    assert.equal(await probeChainId("https://rpc.example/", 1_000, fetcher), null, name);
  }
});

test("a probe that never answers gives up at its timeout", async () => {
  const hang = ((_url: unknown, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
  })) as typeof fetch;
  const started = Date.now();
  assert.equal(await probeChainId("https://rpc.example/", 50, hang), null);
  assert.ok(Date.now() - started < 2_000);
});
