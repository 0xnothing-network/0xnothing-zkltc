import assert from "node:assert/strict";
import test from "node:test";
import { evaluateModule } from "../../../web/tests/helpers/evaluateModule.ts";
import type { KeyValueStore } from "../../src/core/platform/storage.ts";

function fixture() {
  const entries = new Map<string, string>();
  const storage = {
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => entries.set(key, value),
    removeItem: (key: string) => entries.delete(key),
    get length() { return entries.size; },
    key: (index: number) => [...entries.keys()][index] ?? null,
  };
  const listeners = new Set<(event: unknown) => void>();
  const module = evaluateModule<{ persistentStore: KeyValueStore }>(
    new URL("../../src/core/platform/storage.ts", import.meta.url),
    { "./chromeStore": {}, "./env": { isExtension: false, isAndroid: false } },
    { window: { localStorage: storage, addEventListener: (_type: string, listener: (event: unknown) => void) => listeners.add(listener), removeEventListener: (_type: string, listener: (event: unknown) => void) => listeners.delete(listener) } },
  );
  return {
    store: module.persistentStore,
    listeners,
    emit: (key: string | null, newValue: string | null, storageArea: unknown = storage) => {
      for (const listener of listeners) listener({ key, newValue, storageArea });
    },
  };
}

test("web storage subscribers follow same-document writes, batches and removals", async () => {
  const run = fixture();
  const seen: unknown[] = [];
  const stop = run.store.subscribe("settings", (value) => seen.push(value));
  await run.store.set("settings", { network: "litvm" });
  await run.store.setMany([["settings", { network: "custom" }], ["accounts", []]]);
  await run.store.remove("settings");
  assert.deepEqual(seen, [{ network: "litvm" }, { network: "custom" }, undefined]);
  stop();
  await run.store.set("settings", { network: "litvm" });
  assert.equal(seen.length, 3);
  assert.equal(run.listeners.size, 0);
});

test("cross-document storage clears and corrupt records invalidate the subscribed value", () => {
  const run = fixture();
  const seen: unknown[] = [];
  run.store.subscribe("settings", (value) => seen.push(value));
  run.emit("settings", '{"network":"custom"}');
  run.emit(null, null);
  run.emit("settings", "invalid JSON");
  assert.equal((seen[0] as { network: string }).network, "custom");
  assert.equal(seen[1], undefined);
  assert.equal(seen[2], undefined);
});

test("session-storage and unrelated keys cannot trigger persistent subscriptions", () => {
  const run = fixture();
  let changes = 0;
  run.store.subscribe("settings", () => { changes += 1; });
  run.emit("accounts", "{}");
  run.emit("settings", "{}", {});
  assert.equal(changes, 0);
});

test("subscriber exceptions are not mistaken for corrupt JSON or delivered twice", () => {
  const run = fixture();
  let changes = 0;
  run.store.subscribe("settings", () => { changes += 1; throw new Error("Subscriber failed"); });
  assert.throws(() => run.emit("settings", "{}"), /Subscriber failed/);
  assert.equal(changes, 1);
});
