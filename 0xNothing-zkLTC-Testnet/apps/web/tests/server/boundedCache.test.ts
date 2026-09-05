import assert from "node:assert/strict";
import test from "node:test";
import { createBoundedCache } from "../../lib/boundedCache.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

test("a forced result stays cached when an older ordinary request finishes", async () => {
  const cache = createBoundedCache<string[]>({ maxEntries: 2 });
  const old = deferred<string[]>();
  const pending = cache.load("owner", () => old.promise);
  cache.set("owner", ["new NFT"]);
  old.resolve([]);
  await pending;
  assert.deepEqual(cache.get("owner"), ["new NFT"]);
});

test("deleting a key prevents an old load from resurrecting its value", async () => {
  const cache = createBoundedCache<number>({ maxEntries: 2 });
  const old = deferred<number>();
  const pending = cache.load("market", () => old.promise);
  cache.delete("market");
  old.resolve(1);
  await pending;
  assert.equal(cache.get("market"), undefined);
});

test("an invalidated request cannot remove a replacement flight", async () => {
  const cache = createBoundedCache<number>({ maxEntries: 2 });
  const old = deferred<number>();
  const fresh = deferred<number>();
  const first = cache.refresh("market", () => old.promise);
  cache.delete("market");
  const second = cache.refresh("market", () => fresh.promise);
  assert.notEqual(first, second);
  old.resolve(1);
  await first;
  assert.equal(cache.pending("market"), second);
  fresh.resolve(2);
  assert.equal(await second, 2);
  assert.equal(cache.get("market"), 2);
  assert.equal(cache.pending("market"), undefined);
});

test("zero-TTL loads release their flight before the next awaited refresh", async () => {
  const cache = createBoundedCache<number>({ maxEntries: 2 });
  let calls = 0;
  assert.equal(await cache.refresh("force", async () => ++calls, 0), 1);
  assert.equal(await cache.refresh("force", async () => ++calls, 0), 2);
  assert.equal(cache.size, 0);
});

test("concurrent reads coalesce and a rejected load can be retried", async () => {
  const cache = createBoundedCache<number>({ maxEntries: 2 });
  const result = deferred<number>();
  let calls = 0;
  const loader = () => { calls += 1; return result.promise; };
  const first = cache.load("market", loader);
  const second = cache.load("market", loader);
  assert.equal(first, second);
  result.resolve(2);
  await Promise.all([first, second]);
  assert.equal(calls, 1);
  await assert.rejects(cache.refresh("market", async () => { throw new Error("offline"); }), /offline/);
  assert.equal(await cache.refresh("market", async () => 3), 3);
});

test("loader and TTL failures reject the returned promise without detached rejections", async () => {
  const cache = createBoundedCache<number>({ maxEntries: 2 });
  await assert.rejects(async () => cache.load("sync", () => { throw new Error("sync failure"); }), /sync failure/);
  await assert.rejects(cache.load("ttl", async () => 1, () => { throw new Error("TTL failure"); }), /TTL failure/);
});

test("LRU, stale reads, and saturation retain bounded cache behavior", async () => {
  const cache = createBoundedCache<number>({ maxEntries: 2, maxInFlight: 1 });
  cache.set("a", 1);
  cache.set("b", 2);
  assert.equal(cache.entry("a")?.value, 1);
  cache.set("c", 3);
  assert.equal(cache.get("b"), undefined);
  assert.equal(cache.size, 2);
  const slow = deferred<number>();
  const pending = cache.load("pending", () => slow.promise);
  assert.equal(cache.saturated(), true);
  assert.equal(await cache.load("overflow", async () => 4), 4);
  assert.equal(cache.get("overflow"), undefined);
  slow.resolve(5);
  await pending;
  assert.equal(cache.saturated(), false);
  assert.equal(cache.size, 2);
});
