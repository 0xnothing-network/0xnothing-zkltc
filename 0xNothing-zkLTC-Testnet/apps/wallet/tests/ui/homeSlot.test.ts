import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { firstRunDue, homeSlot } from "../../src/ui/lib/homeSlot.ts";
import {
  compareVersions,
  MAX_NEWS_LINES,
  newsLines,
  parseSeenVersion,
  WALLET_NEWS,
  whatsNewDue,
} from "../../src/ui/lib/whatsNew.ts";

/** F8 first-run card and F16 What is new, sharing one slot on Home. */
const source = (path: string): string => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
const row = (balance: bigint, readError: string | null = null) => ({ balance, readError });

test("the first-run card needs a loaded, empty portfolio and no history at all", () => {
  const empty = { totalWad: 0n, rows: [row(0n), row(0n)] };
  assert.equal(firstRunDue(empty, false, 0), true);
  assert.equal(firstRunDue(empty, false, 1), false);
  assert.equal(firstRunDue(empty, false, null), false);
  assert.equal(firstRunDue(empty, true, 0), false);
  assert.equal(firstRunDue(null, false, 0), false);
  assert.equal(firstRunDue({ totalWad: 1n, rows: [row(0n)] }, false, 0), false);
  // A balance without a price is still a balance.
  assert.equal(firstRunDue({ totalWad: 0n, rows: [row(0n), row(5n)] }, false, 0), false);
  // An unreadable balance is a placeholder zero, not an empty wallet.
  assert.equal(firstRunDue({ totalWad: 0n, rows: [row(0n, "timeout")] }, false, 0), false);
});

test("What is new wins the slot; the two never show together", () => {
  assert.equal(homeSlot(true, true), "news");
  assert.equal(homeSlot(true, false), "news");
  assert.equal(homeSlot(false, true), "first");
  assert.equal(homeSlot(false, false), null);
});

test("versions compare by number and junk is never a seen version", () => {
  assert.ok(compareVersions("1.0.9", "1.0.10") < 0);
  assert.ok(compareVersions("1.1.0", "1.0.10") > 0);
  assert.equal(compareVersions("1.0.10", "1.0.10"), 0);
  assert.equal(parseSeenVersion("1.0.10"), "1.0.10");
  for (const bad of ["", "1.0", "v1.0.10", "1.0.10-beta", "1.0.10 ", 1010, null, { version: "1.0.10" }]) {
    assert.equal(parseSeenVersion(bad), null);
  }
});

test("due after an update or from a wallet older than the key; never on the same or a newer version", () => {
  assert.equal(whatsNewDue(null, "1.0.10", 5), true);
  assert.equal(whatsNewDue("junk", "1.0.10", 5), true);
  assert.equal(whatsNewDue("1.0.9", "1.0.10", 5), true);
  assert.equal(whatsNewDue("1.0.10", "1.0.10", 5), false);
  assert.equal(whatsNewDue("1.0.11", "1.0.10", 5), false);
  assert.equal(whatsNewDue(null, "1.0.10", 0), false);
});

test("at most five lines, and Android is never told about extension-only features", () => {
  const pkg = JSON.parse(source("package.json")) as { version: string };
  assert.ok(WALLET_NEWS[pkg.version], "the running version has its highlights");
  for (const lines of Object.values(WALLET_NEWS)) assert.ok(lines.length <= MAX_NEWS_LINES);
  const all = newsLines(pkg.version, true);
  const android = newsLines(pkg.version, false);
  assert.ok(android.length < all.length);
  assert.ok(android.every((line) => line.extensionOnly !== true));
  assert.deepEqual(newsLines("0.0.1", true), []);
});

test("onboarding marks this version seen, Home shows the slot under the balance, the erase forgets it", () => {
  const context = source("src/ui/state/WalletContext.tsx");
  assert.match(context, /if \(phase === "onboarding"\) void markVersionSeen\(__WALLET_VERSION__\);/u);
  const home = source("src/ui/screens/Home.tsx");
  const slot = home.indexOf("<HomeNotice ");
  assert.ok(slot > home.indexOf('className="w-total-block"'));
  assert.ok(slot < home.indexOf('className="w-actions"'));
  const notice = source("src/ui/screens/home/HomeNotice.tsx");
  assert.match(notice, /listRecords\(address, network\)/u);
  assert.doesNotMatch(notice, /listSettled|listWatched|faucet/iu);
  assert.match(notice, /markVersionSeen\(VERSION\)/u);
  assert.match(source("src/core/keyring/vault.ts"), /persistentStore\.remove\(STORAGE_KEYS\.seenVersion\)/u);
});
