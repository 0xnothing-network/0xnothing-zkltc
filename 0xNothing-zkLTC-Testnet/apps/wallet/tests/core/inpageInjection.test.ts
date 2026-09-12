import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const code = ts.transpileModule(readFileSync(new URL("../../src/extension/inpage.ts", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

function harness(existing?: object) {
  const events: string[] = [];
  const posts: unknown[] = [];
  const registrations: string[] = [];
  const ethereum = {};
  const window = {
    ethereum, location: { origin: "https://app.test" },
    addEventListener: (event: string) => registrations.push(event),
    dispatchEvent: (event: { type: string }) => events.push(event.type),
    postMessage: (message: unknown) => posts.push(message),
    setTimeout: () => 1, clearTimeout: () => {},
  };
  if (existing) Object.defineProperty(window, "zeroxnothing", { value: existing, configurable: false });
  const inject = () => runInNewContext(code, {
    window, exports: {},
    CustomEvent: class { type: string; constructor(type: string) { this.type = type; } },
    require: () => ({ isContentMessage: () => false, PROVIDER_CHAIN_ID_HEX: "0x1159", newProviderUuid: () => "test-uuid" }),
  });
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

test("an existing non-configurable namespace is preserved without requests or announcements", () => {
  const existing = {};
  const h = harness(existing);
  assert.doesNotThrow(h.inject);
  assert.equal(Object.getOwnPropertyDescriptor(h.window, "zeroxnothing")?.value, existing);
  assert.equal(h.posts.length, 0);
  assert.equal(h.registrations.length, 0);
});
