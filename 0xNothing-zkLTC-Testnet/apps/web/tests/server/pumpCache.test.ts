import assert from "node:assert/strict";
import { test } from "node:test";
import { createBoundedCache } from "../../lib/boundedCache.ts";
import type { PumpCacheBusyError as BusyError, withPumpCache as WithPumpCache } from "../../features/pump/server/cache.ts";
import { evaluateModule } from "../helpers/evaluateModule.ts";

function harness() {
  const background: Array<() => unknown> = [];
  const cache = evaluateModule<{ withPumpCache: typeof WithPumpCache; PumpCacheBusyError: typeof BusyError }>(
    new URL("../../features/pump/server/cache.ts", import.meta.url),
    { "server-only": {}, "next/server": { after: (task: () => unknown) => { background.push(task); } }, "@/lib/boundedCache": { createBoundedCache } },
    { Error, Promise },
  );
  return { ...cache, background };
}

test("a saturated pump cache refuses new keys, still joins loads in flight and keeps serving snapshots", async () => {
  const { withPumpCache, PumpCacheBusyError } = harness();
  const policy = { ttlMs: 0, staleMs: 60_000 };
  assert.equal(await withPumpCache("warm", async () => "snapshot", policy), "snapshot");

  const release: Array<() => void> = [];
  const hung = () => new Promise<string>((resolve) => { release.push(() => resolve("done")); });
  const loads = Array.from({ length: 96 }, (_, index) => withPumpCache(`key:${index}`, hung, policy));

  await assert.rejects(withPumpCache("one-more", async () => "never", policy), PumpCacheBusyError);
  // A key that is already loading costs nothing extra, so its caller still waits for it.
  const joined = withPumpCache("key:0", async () => "duplicate", policy);
  // An aged snapshot is answered as it is: its refresh would be one more upstream load.
  let refreshed = false;
  assert.equal(await withPumpCache("warm", async () => { refreshed = true; return "newer"; }, { ...policy, fresh: true }), "snapshot");
  assert.equal(refreshed, false);

  release.forEach((done) => done());
  assert.deepEqual(await Promise.all(loads), Array(96).fill("done"));
  assert.equal(await joined, "done");
  assert.equal(await withPumpCache("one-more", async () => "now", policy), "now");
});
