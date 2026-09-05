import assert from "node:assert/strict";
import test from "node:test";
import { getAddress, isAddress, zeroAddress } from "viem";
import { evaluateModule } from "../helpers/evaluateModule.ts";

type Hook = typeof import("../../features/fi/lib/hooks/useImportedSwapAsset.ts").useImportedSwapAsset;
type State = ReturnType<Hook>;
type Effect = { deps: unknown[]; cleanup?: () => void };
type Instance = { state?: State; effect?: Effect };

function harness() {
  let current: Instance;
  let timerId = 0;
  const timers = new Map<number, { callback: () => void; delay: number }>();
  const requests: string[] = [];
  const hooks = evaluateModule<{ useImportedSwapAsset: Hook }>(
    new URL("../../features/fi/lib/hooks/useImportedSwapAsset.ts", import.meta.url),
    {
      react: {
        useMemo: (calculate: () => unknown) => calculate(),
        useState(initial: State) {
          const instance = current;
          instance.state ??= initial;
          return [instance.state, (value: State) => { instance.state = value; }];
        },
        useEffect(callback: () => (() => void) | undefined, deps: unknown[]) {
          const old = current.effect;
          if (old && deps.every((value, index) => Object.is(value, old.deps[index]))) return;
          old?.cleanup?.();
          current.effect = { deps, cleanup: callback() };
        },
      },
      viem: { getAddress, isAddress, zeroAddress },
      "@fi/config/paths": { fiPath: (path: string) => `/0xFi${path}` },
    },
    {
      AbortController, Error,
      window: {
        setTimeout(callback: () => void, delay: number) {
          timers.set(++timerId, { callback, delay });
          return timerId;
        },
        clearTimeout: (id: number) => timers.delete(id),
      },
      fetch: async (url: string) => {
        requests.push(url);
        return {
          ok: true,
          status: 200,
          json: async () => ({
            status: "ready",
            data: {
              address: url.slice(-42), name: "Token", symbol: "T", decimals: 18,
              totalSupply: "100", metadataSource: "onchain", explorerStatus: "not-indexed",
            },
          }),
        };
      },
    },
  );
  return {
    requests,
    timers,
    render(instance: Instance, address: string, enabled = true) {
      current = instance;
      hooks.useImportedSwapAsset(address, enabled);
      return hooks.useImportedSwapAsset(address, enabled);
    },
    async flushDebounce() {
      for (const [id, timer] of [...timers]) {
        if (timer.delay !== 280) continue;
        timers.delete(id);
        timer.callback();
      }
      await new Promise<void>((resolve) => setImmediate(resolve));
    },
    unmount(instance: Instance) { instance.effect?.cleanup?.(); },
  };
}

const address = (index: number) => `0x${index.toString(16).padStart(40, "0")}`;

test("cancelled debounce candidates do not spend the session's token scan budget", async () => {
  const h = harness();
  const instance: Instance = {};
  for (let index = 1; index <= 25; index += 1) {
    assert.equal(h.render(instance, address(index)).status, "loading");
  }
  assert.equal(h.requests.length, 0);
  await h.flushDebounce();
  assert.equal(h.requests.length, 1);
  assert.equal(h.render(instance, address(25)).status, "ready");
  h.unmount(instance);
});

test("finished token verification clears its timeout without waiting for unmount", async () => {
  const h = harness();
  const instance: Instance = {};
  h.render(instance, address(1));
  await h.flushDebounce();
  assert.equal(h.render(instance, address(1)).status, "ready");
  assert.equal(h.timers.size, 0);
  h.unmount(instance);
});

test("concurrent token pickers still share the 20-address limit when debounces fire", async () => {
  const h = harness();
  const instance: Instance = {};
  for (let index = 1; index <= 19; index += 1) {
    h.render(instance, address(index));
    await h.flushDebounce();
  }
  const first: Instance = {};
  const second: Instance = {};
  h.render(first, address(20));
  h.render(second, address(21));
  await h.flushDebounce();
  assert.equal(h.requests.length, 20);
  assert.equal(h.render(first, address(20)).status, "ready");
  assert.equal(h.render(second, address(21)).status, "unsupported");
  assert.equal(h.render(instance, address(1)).status, "ready");
  h.unmount(instance);
  h.unmount(first);
  h.unmount(second);
});
