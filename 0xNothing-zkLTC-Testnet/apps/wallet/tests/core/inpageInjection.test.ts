import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createContext, runInContext } from "node:vm";
import ts from "typescript";

const transpile = (path: string) => ts.transpileModule(readFileSync(new URL(path, import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const code = transpile("../../src/extension/inpage.ts");
// The bounds check compares prototypes, so it must run in the page's own realm.
const protocolCode = transpile("../../src/extension/protocol.ts");

function harness(existing?: object, framed = false) {
  const events: string[] = [];
  const posts: unknown[] = [];
  const registrations: string[] = [];
  const ethereum = {};
  const window: Record<string, unknown> = {
    ethereum, location: { origin: "https://app.test" },
    addEventListener: (event: string) => registrations.push(event),
    dispatchEvent: (event: { type: string }) => events.push(event.type),
    postMessage: (message: unknown) => posts.push(message),
    setTimeout: () => 1, clearTimeout: () => {},
  };
  window.top = framed ? {} : window;
  if (existing) Object.defineProperty(window, "zeroxnothing", { value: existing, configurable: false });
  const inject = () => {
    const protocol: { isBoundedRpcCall?: unknown } = {};
    const context = createContext({});
    // Its own `exports` binding: the emitted code reads its exported constants back
    // through `exports`, which the inpage module below rebinds.
    (runInContext(`(function (exports) {\n${protocolCode}\n})`, context) as (target: object) => void)(protocol);
    Object.assign(context, {
      window, exports: {},
      CustomEvent: class { type: string; constructor(type: string) { this.type = type; } },
      require: () => ({
        isBoundedRpcCall: protocol.isBoundedRpcCall,
        isContentMessage: () => false,
        PROVIDER_CHAIN_ID_HEX: "0x1159",
        newProviderUuid: () => "test-uuid",
      }),
    });
    runInContext(code, context);
  };
  return { window, inject, events, registrations, posts, ethereum };
}

test("duplicate inpage injection retains one provider and one set of listeners", () => {
  const h = harness();
  h.inject();
  const provider = Object.getOwnPropertyDescriptor(h.window, "zeroxnothing")?.get?.();
  assert.ok(provider);
  h.inject();
  assert.equal(Object.getOwnPropertyDescriptor(h.window, "zeroxnothing")?.get?.(), provider);
  assert.deepEqual(h.registrations, ["message", "eip6963:requestProvider"]);
  assert.deepEqual(h.events, ["eip6963:announceProvider"]);
  assert.equal(h.posts.length, 2);
  assert.equal(h.window.ethereum, h.ethereum);
});

test("only the top frame syncs chain and accounts at load", () => {
  const h = harness(undefined, true);
  h.inject();
  assert.ok(Object.getOwnPropertyDescriptor(h.window, "zeroxnothing")?.get?.());
  assert.deepEqual(h.events, ["eip6963:announceProvider"]);
  assert.equal(h.posts.length, 0);
});

test("a call the relay would drop fails at once instead of waiting for the timeout", async () => {
  const h = harness(undefined, true);
  h.inject();
  const provider = Object.getOwnPropertyDescriptor(h.window, "zeroxnothing")?.get?.() as {
    request(args: { method: string; params?: unknown }): Promise<unknown>;
  };
  for (const params of [{ type: "ERC20" }, [{ to: "0x1", gas: undefined }], [1n]]) {
    await assert.rejects(provider.request({ method: "wallet_watchAsset", params }), { code: -32602 });
  }
  assert.equal(h.posts.length, 0);
  void provider.request({ method: "eth_chainId" });
  assert.equal(h.posts.length, 1);
});

test("an existing non-configurable namespace is preserved without requests or announcements", () => {
  const existing = {};
  const h = harness(existing);
  assert.doesNotThrow(h.inject);
  assert.equal(Object.getOwnPropertyDescriptor(h.window, "zeroxnothing")?.value, existing);
  assert.equal(h.posts.length, 0);
  assert.equal(h.registrations.length, 0);
});
