import assert from "node:assert/strict";
import test from "node:test";
import { evaluateModule } from "../helpers/evaluateModule.ts";

type Element = { type: (props: Record<string, unknown>) => Element; props: Record<string, unknown> };
function find(root: unknown, key: string): Element | undefined {
  if (Array.isArray(root)) return root.map((item) => find(item, key)).find(Boolean);
  if (!root || typeof root !== "object" || !("props" in root)) return;
  const element = root as Element;
  return key in element.props ? element : find(element.props.children, key);
}

test("replacing an activity request clears load-more and ignores the cancelled response", async () => {
  let stateIndex = 0;
  let stage = "body";
  const states: unknown[] = [];
  const callbacks: ((...args: unknown[]) => Promise<void>)[] = [];
  const requests: { signal: AbortSignal; resolve: (value: unknown) => void }[] = [];
  const jsx = (type: unknown, props: unknown) => ({ type, props });
  const page = evaluateModule<{ default: () => Element }>(new URL("../../app/0xpixel/marketplace/page.tsx", import.meta.url), {
    react: {
      useState: (initial: unknown) => {
        const index = stateIndex++;
        states[index] = stage === "body" && index === 3 ? { listings: [], tokens: {} } : initial;
        return [states[index], (value: unknown) => { states[index] = typeof value === "function" ? value(states[index]) : value; }];
      },
      useMemo: (fn: () => unknown) => fn(), useRef: (current: unknown) => ({ current }), useEffect: () => {},
      useCallback: (fn: (...args: unknown[]) => Promise<void>) => { callbacks.push(fn); return fn; },
    },
    "react/jsx-runtime": { jsx, jsxs: jsx },
    wagmi: { useAccount: () => ({}) }, viem: {}, "@/lib/contract": {},
    "@/lib/marketplaceAbi": {}, "@/features/pixel/components/Skeleton": {},
    "@/components/Toast": {}, "@/lib/chainSwitch": {}, "@/lib/actionLock": {},
  }, {
    AbortController, URLSearchParams, console,
    fetch: (_url: string, options: { signal: AbortSignal }) => new Promise((resolve) => {
      requests.push({ signal: options.signal, resolve });
    }),
  });
  const body = find(page.default(), "userAddress")!;
  const activity = find(body.type(body.props), "refreshKey")!;
  stage = "activity"; stateIndex = 0; callbacks.length = 0;
  activity.type(activity.props);
  const fetchActivity = callbacks[0];
  const old = fetchActivity(24);
  assert.equal(states[3], true);
  const fresh = fetchActivity(0);
  assert.equal(requests[0].signal.aborted, true);
  assert.equal(states[3], false, "the replacement owns and resets the loading indicator");
  requests[1].resolve({ ok: true, json: async () => ({ events: [{ id: "fresh" }] }) });
  await fresh;
  requests[0].resolve({ ok: true, json: async () => ({ events: [{ id: "cancelled" }] }) });
  await old;
  assert.deepEqual(JSON.parse(JSON.stringify(states[1])), [{ id: "fresh" }]);
});
