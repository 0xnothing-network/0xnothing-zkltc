import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { EMPTY_WATCH, MAX_HOME_PENDING, pendingRows, SETTLED_SHOWN_MS, trackPending, watchPending } from "../../src/ui/lib/pendingRows.ts";

/** F6: the wallet's own pending rows on Home, settling in place. */
const row = (hash: string, status: string, at: number) => ({ hash, status, at });

test("only pending or already-watched rows show, newest first, three at most", () => {
  assert.equal(MAX_HOME_PENDING, 3);
  const rows = [
    row("a", "pending", 1),
    row("b", "success", 5),
    row("c", "pending", 3),
    row("d", "failed", 4),
    row("e", "pending", 2),
    row("f", "pending", 6),
  ];
  assert.deepEqual(pendingRows(rows, new Set()).map((entry) => entry.hash), ["f", "c", "e"]);
  // A row seen pending earlier keeps its place after it settles; one never seen pending does not show.
  assert.deepEqual(pendingRows(rows, new Set(["d"]), 10).map((entry) => entry.hash), ["f", "d", "c", "e", "a"]);
  assert.deepEqual(pendingRows([row("b", "success", 5)], new Set()), []);
});

test("watching adds pending hashes and keeps the same set when nothing is new", () => {
  const empty: ReadonlySet<string> = new Set();
  assert.equal(watchPending(empty, [row("a", "success", 1)]), empty);
  const once = watchPending(empty, [row("a", "pending", 1), row("b", "dropped", 2)]);
  assert.deepEqual([...once], ["a"]);
  assert.equal(watchPending(once, [row("a", "pending", 1)]), once);
  // Settling does not unwatch: the row stays on Home with its new status.
  assert.equal(watchPending(once, [row("a", "success", 1)]), once);
});

test("Home shows the pending rows above the tabs through the storage-first read", () => {
  const home = readFileSync(new URL("../../src/ui/screens/Home.tsx", import.meta.url), "utf8");
  assert.ok(home.indexOf("<PendingTxs />") > 0);
  assert.ok(home.indexOf("<PendingTxs />") < home.indexOf('className="w-tabs"'));
  const pending = readFileSync(new URL("../../src/ui/screens/home/PendingTxs.tsx", import.meta.url), "utf8");
  assert.match(pending, /listWatched\(address, network\)/u);
  assert.doesNotMatch(pending, /listSettled/u);
  assert.match(pending, /openExternal\(url\)/u);
});

test("a settled row leaves Home a minute after it was first seen settled", () => {
  const start = trackPending(EMPTY_WATCH, [row("a", "pending", 1), row("b", "pending", 2)], 1_000);
  assert.deepEqual([...start.hashes], ["a", "b"]);
  assert.equal(start.settledAt.size, 0);
  // Nothing new: the same object.
  assert.equal(trackPending(start, [row("a", "pending", 1), row("b", "pending", 2)], 2_000), start);
  const settled = trackPending(start, [row("a", "success", 1), row("b", "pending", 2)], 5_000);
  assert.equal(settled.settledAt.get("a"), 5_000);
  // Still shown until the minute is up, with its new status.
  const later = trackPending(settled, [row("a", "success", 1), row("b", "pending", 2)], 5_000 + SETTLED_SHOWN_MS - 1);
  assert.equal(later, settled);
  assert.deepEqual(pendingRows([row("a", "success", 1), row("b", "pending", 2)], later.hashes).map((entry) => entry.hash), ["b", "a"]);
  const gone = trackPending(settled, [row("a", "success", 1), row("b", "pending", 2)], 5_000 + SETTLED_SHOWN_MS);
  assert.deepEqual([...gone.hashes], ["b"]);
  assert.equal(gone.settledAt.has("a"), false);
  assert.deepEqual(pendingRows([row("a", "success", 1), row("b", "pending", 2)], gone.hashes).map((entry) => entry.hash), ["b"]);
  // The empty start is never changed in place.
  assert.equal(EMPTY_WATCH.hashes.size + EMPTY_WATCH.settledAt.size, 0);
  const pending = readFileSync(new URL("../../src/ui/screens/home/PendingTxs.tsx", import.meta.url), "utf8");
  assert.ok(pending.includes("setWatch((prev) => trackPending(prev, read.data ?? [], Date.now()));"));
  assert.ok(pending.includes("const rows = pendingRows(read.data ?? [], watch.hashes);"));
});
