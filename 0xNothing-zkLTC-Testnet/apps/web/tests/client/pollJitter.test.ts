import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import test from "node:test";
import type { VisibilityRefreshOptions } from "../../lib/pollJitter.ts";
import { evaluateModule } from "../helpers/evaluateModule.ts";

function harness() {
  const refs: Array<{ current: unknown }> = [];
  const effects: Array<{ deps: unknown[]; cleanup?: () => void }> = [];
  let refIndex = 0;
  let effectIndex = 0;
  const timers = new Map<number, () => void>();
  const listeners = new Set<() => void>();
  let nextTimer = 0;
  const document = {
    visibilityState: "visible",
    addEventListener: (_: string, callback: () => void) => listeners.add(callback),
    removeEventListener: (_: string, callback: () => void) => listeners.delete(callback),
  };
  const hooks = evaluateModule<{ useVisibilityRefresh: (options: VisibilityRefreshOptions) => void }>(
    new URL("../../lib/pollJitter.ts", import.meta.url),
    { react: {
      useRef(value: unknown) { return refs[refIndex++] ?? (refs[refIndex - 1] = { current: value }); },
      useEffect(effect: () => (() => void) | undefined, deps: unknown[]) {
        const index = effectIndex++;
        const old = effects[index];
        if (old && old.deps.length === deps.length && deps.every((dep, i) => Object.is(dep, old.deps[i]))) return;
        old?.cleanup?.();
        effects[index] = { deps, cleanup: effect() };
      },
    } },
    { document, Date, Promise, window: {
      crypto: webcrypto,
      setTimeout(callback: () => void) { timers.set(++nextTimer, callback); return nextTimer; },
      clearTimeout: (id: number) => timers.delete(id),
    } },
  );
  return {
    timers,
    document,
    render(options: VisibilityRefreshOptions) { refIndex = 0; effectIndex = 0; hooks.useVisibilityRefresh(options); },
    visible() { document.visibilityState = "visible"; for (const listener of listeners) listener(); },
    flush() { const callbacks = [...timers.values()]; timers.clear(); for (const callback of callbacks) callback(); },
    unmount() { for (const effect of effects) effect.cleanup?.(); },
  };
}

function options(refetch: () => Promise<unknown>): VisibilityRefreshOptions {
  return { key: "pump-market", dataUpdatedAt: 0, isFetching: false, maxAgeMs: 1_000, refetch };
}

test("visibility delay rechecks a request that started before its timer fired", () => {
  const h = harness();
  let calls = 0;
  const state = options(async () => { calls += 1; });
  h.render(state);
  h.visible();
  assert.equal(h.timers.size, 1);
  h.render({ ...state, isFetching: true });
  h.flush();
  assert.equal(calls, 0);
});

test("visibility delay skips data refreshed by another observer", () => {
  const h = harness();
  let calls = 0;
  const state = options(async () => { calls += 1; });
  h.render(state);
  h.visible();
  h.render({ ...state, dataUpdatedAt: Date.now() });
  h.flush();
  assert.equal(calls, 0);
});

test("hidden tabs and unmounted queries do not run a pending refresh", () => {
  const h = harness();
  let calls = 0;
  h.render(options(async () => { calls += 1; }));
  h.visible();
  h.document.visibilityState = "hidden";
  h.flush();
  assert.equal(calls, 0);
  h.visible();
  h.unmount();
  h.flush();
  assert.equal(calls, 0);
});

test("visible stale data refreshes once and handles a rejected background read", async () => {
  const h = harness();
  let calls = 0;
  h.render(options(async () => { calls += 1; throw new Error("offline"); }));
  h.visible();
  h.visible();
  h.flush();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
  h.unmount();
});
