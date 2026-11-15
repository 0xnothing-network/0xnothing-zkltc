import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { rpcAccessMissing, rpcHost } from "../../src/ui/lib/rpcPermission.ts";

const permissions = (granted: string[], fail = false) => {
  const asked: string[][] = [];
  return {
    asked,
    async contains(request: { origins: string[] }): Promise<boolean> {
      asked.push(request.origins);
      if (fail) throw new Error("no permissions API");
      return request.origins.every((origin) => granted.includes(origin));
    },
  };
};

test("a saved loopback RPC without its port grant is reported missing", async () => {
  const api = permissions([]);
  assert.equal(await rpcAccessMissing("http://127.0.0.1:8545", api), true);
  assert.deepEqual(api.asked, [["http://127.0.0.1:8545/*"]]);
  assert.equal(await rpcAccessMissing("http://127.0.0.1:8545", permissions(["http://127.0.0.1:8545/*"])), false);
});

test("no API, a bad URL or a failed check never nags", async () => {
  assert.equal(await rpcAccessMissing("http://localhost:8545", undefined), false);
  assert.equal(await rpcAccessMissing("ftp://rpc.example.test", permissions([])), false);
  assert.equal(await rpcAccessMissing("http://localhost:8545", permissions([], true)), false);
});

test("the note names the host with its port", () => {
  assert.equal(rpcHost("http://[::1]:8545/rpc"), "[::1]:8545");
  assert.equal(rpcHost("https://rpc.example.test/"), "rpc.example.test");
});

test("Allow asks Chrome from the click itself, on Settings and Home", () => {
  const read = (path: string): string => readFileSync(new URL(`../../src/ui/${path}`, import.meta.url), "utf8");
  const prompt = read("components/RpcAccessPrompt.tsx");
  // No await between the click and chrome.permissions.request.
  assert.match(prompt, /const allow = \(\): void => \{\s*if \(asking\) return;\s*setAsking\(true\);[^]*?void requestRpcPermission\(rpcUrl\)/u);
  assert.match(prompt, /<Button size="sm" disabled=\{asking\} onClick=\{allow\}>\{t\("set\.rpcAccessAllow"\)\}<\/Button>/u);
  assert.match(prompt, /t\("set\.rpcAccessNeeded", \{ host: rpcHost\(rpcUrl\) \}\)/u);
  assert.match(read("screens/Settings.tsx"), /<RpcAccessPrompt rpcUrl=\{network\.rpcUrl\} \/>/u);
  assert.match(read("screens/Home.tsx"), /<RpcAccessPrompt rpcUrl=\{network\.rpcUrl\} \/>/u);
});

test("Android refuses a plain-HTTP RPC before any permission or chain check", () => {
  const settings = readFileSync(new URL("../../src/ui/screens/Settings.tsx", import.meta.url), "utf8");
  const refuse = settings.indexOf("if (isAndroid && cleartextRpcUrl(candidate.rpcUrl)) {\n      setNetworkError(t(\"set.networkCleartext\"));\n      return;");
  assert.notEqual(refuse, -1);
  assert.ok(refuse > settings.indexOf("if (!candidate) {"));
  assert.ok(refuse < settings.indexOf("requestRpcPermission(candidate.rpcUrl)"));
});
