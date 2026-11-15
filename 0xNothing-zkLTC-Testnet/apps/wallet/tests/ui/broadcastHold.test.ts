import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { TxKind, TxRecord } from "../../src/core/services/history.ts";
import {
  BROADCAST_ROW_GRACE_MS,
  BROADCAST_SEED_MAX_AGE_MS,
  broadcastOutcome,
  missingRowReleases,
  seedBroadcastHold,
} from "../../src/ui/lib/broadcastHold.ts";

const ACCOUNT = "0x0000000000000000000000000000000000000001";
const HASH = `0x${"ab".repeat(32)}` as const;
const OTHER = `0x${"cd".repeat(32)}` as const;
const SEND: readonly TxKind[] = ["send"];
const NOW = 1_800_000_000_000;

function row(
  status: TxRecord["status"],
  hash: `0x${string}` = HASH,
  kind: TxKind = "send",
  at = NOW,
): TxRecord {
  return { hash, account: ACCOUNT, kind, status, at };
}

test("a lost broadcast holds Confirm while its History row is pending", () => {
  assert.equal(broadcastOutcome([row("pending")], HASH, SEND), "pending");
  assert.equal(broadcastOutcome([row("pending", `0x${"AB".repeat(32)}`)], HASH, SEND), "pending");
});

test("a lost broadcast that is mined runs the success path and never re-arms the review", () => {
  assert.equal(broadcastOutcome([row("success")], HASH, SEND), "sent");
  assert.equal(broadcastOutcome([row("success", `0x${"AB".repeat(32)}`)], HASH, SEND), "sent");
});

test("a lost broadcast gives Confirm back only when the job itself did not go out", () => {
  for (const status of ["failed", "dropped"] as const) {
    assert.equal(broadcastOutcome([row(status)], HASH, SEND), "retry", status);
  }
  // A mined approval is a step, not the job: the job still has to be confirmed.
  assert.equal(broadcastOutcome([row("success", HASH, "approve")], HASH, SEND), "retry");
});

test("a missing row holds until it was seen and went, or the grace ran out", () => {
  assert.equal(broadcastOutcome([row("pending", OTHER)], HASH, SEND), "missing");
  assert.equal(broadcastOutcome([], HASH, SEND), "missing");
  assert.equal(missingRowReleases(false, NOW, NOW), false);
  assert.equal(missingRowReleases(false, NOW, NOW + BROADCAST_ROW_GRACE_MS - 1), false);
  assert.equal(missingRowReleases(false, NOW, NOW + BROADCAST_ROW_GRACE_MS), true);
  assert.equal(missingRowReleases(true, NOW, NOW), true);
});

test("a reopened screen is held by its own newest recent pending row", () => {
  const older = row("pending", OTHER, "send", NOW - 5_000);
  assert.equal(seedBroadcastHold([older, row("pending")], SEND, NOW), HASH);
  // Settled rows, other kinds (approvals, swaps) and stale rows hold nothing.
  assert.equal(seedBroadcastHold([row("success"), row("dropped"), row("failed")], SEND, NOW), null);
  assert.equal(seedBroadcastHold([row("pending", HASH, "approve"), row("pending", HASH, "swap")], SEND, NOW), null);
  assert.equal(seedBroadcastHold([row("pending", HASH, "send", NOW - BROADCAST_SEED_MAX_AGE_MS - 1)], SEND, NOW), null);
  assert.equal(seedBroadcastHold([row("pending", HASH, "send", NOW - BROADCAST_SEED_MAX_AGE_MS)], SEND, NOW), HASH);
  // A row stamped far ahead by a skewed clock must not hold for ever.
  assert.equal(seedBroadcastHold([row("pending", HASH, "send", NOW + 120_000)], SEND, NOW), null);
});

test("every in-wallet confirm is held after a BroadcastUnknownError", () => {
  for (const screen of ["Send.tsx", "send/SendNft.tsx", "MintNusd.tsx", "Earn.tsx", "Swap.tsx", "Lend.tsx"]) {
    const source = readFileSync(new URL(`../../src/ui/screens/${screen}`, import.meta.url), "utf8");
    assert.match(source, /useBroadcastHold\(address, network, [A-Z]+_KINDS\)/u, screen);
    // The hold carries the screen's success path for a broadcast later found mined.
    assert.match(source, /cause instanceof BroadcastUnknownError\) \{\n\s+broadcast\.hold\(cause\.hash, sent(?:Later)?\);/u, screen);
    assert.match(source, /\|\| broadcast\.held\n\s+\|\| !confirmGate\.tryEnter\(\)/u, screen);
    assert.match(source, /(?:&& !broadcast\.held\}|\|\| broadcast\.held\})/u, screen);
  }
});

test("a lost Send broadcast forgets the draft so a reopened Send cannot offer it again", () => {
  const source = readFileSync(new URL("../../src/ui/screens/Send.tsx", import.meta.url), "utf8");
  assert.match(
    source,
    /broadcast\.hold\(cause\.hash, sent\);\n(?:\s+\/\/.*\n)*\s+edited\.current = false;\n\s+void clearSendDraft\(\)/u,
  );
});
