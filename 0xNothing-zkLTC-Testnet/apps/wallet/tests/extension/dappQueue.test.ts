import assert from "node:assert/strict";
import { test } from "node:test";

// dapp.ts reads `chrome` when it loads, so the in-memory storage goes in first and
// the module is imported after it. Each test file runs in its own process.
const store: Record<string, unknown> = {};
type Listener = (changes: Record<string, { newValue?: unknown }>, area: string) => void;
const listeners = new Set<Listener>();
const local = {
  async get(key: string | null) {
    return key === null ? structuredClone(store) : { [key]: structuredClone(store[key]) };
  },
  async set(bag: Record<string, unknown>) {
    const changes: Record<string, { newValue?: unknown }> = {};
    for (const [key, value] of Object.entries(bag)) {
      store[key] = structuredClone(value);
      changes[key] = { newValue: structuredClone(value) };
    }
    for (const listener of listeners) listener(changes, "local");
  },
  async remove(key: string) {
    delete store[key];
  },
};
(globalThis as { chrome?: unknown }).chrome = {
  storage: {
    local,
    session: local,
    onChanged: {
      addListener: (listener: Listener) => listeners.add(listener),
      removeListener: (listener: Listener) => listeners.delete(listener),
    },
  },
};

const dapp = await import("../../src/core/services/dapp.ts");
const { STORAGE_KEYS } = await import("../../src/core/platform/storageKeys.ts");

const account = `0x${"11".repeat(20)}` as const;
const to = `0x${"22".repeat(20)}` as const;
const hash = `0x${"ab".repeat(32)}`;

async function queued(id: string, at = Date.now(), extra: Partial<import("../../src/core/services/dapp.ts").DappRequest> = {}) {
  const admission = await dapp.pushPending({
    id, origin: `https://${id}.example`, kind: "transaction", at, account, tx: { to, value: "0x1" }, ...extra,
  });
  assert.equal(admission.accepted, true);
}

async function reset(): Promise<void> {
  await local.set({ [STORAGE_KEYS.pending]: [], [STORAGE_KEYS.resolved]: [] });
}

test("a failed claim tells the window why", async () => {
  await reset();
  assert.deepEqual(await dapp.claimPendingRequest("nobody"), { reason: "missing" });
  await queued("fresh");
  const first = await dapp.claimPendingRequest("fresh");
  assert.ok("claim" in first);
  assert.deepEqual(await dapp.claimPendingRequest("fresh"), { reason: "claimed" });
  await queued("late", Date.now() - dapp.DAPP_REQUEST_TIMEOUT_MS + dapp.DAPP_APPROVAL_EXECUTION_BUDGET_MS - 1_000);
  assert.deepEqual(await dapp.claimPendingRequest("late"), { reason: "expired" });
});

test("the worker timeout on an unclaimed row answers 4001 and drops it", async () => {
  await reset();
  await queued("idle");
  const answer = await dapp.awaitResolution("idle", 20);
  assert.equal(answer.code, 4001);
  assert.deepEqual(await dapp.listPending(), []);
});

test("the worker timeout on a claimed row never says rejected, and the window's hash still lands", async () => {
  await reset();
  await queued("busy");
  const outcome = await dapp.claimPendingRequest("busy");
  assert.ok("claim" in outcome);
  const started = Date.now();
  const answer = await dapp.awaitResolution("busy", 20);
  assert.equal(answer.code, -32603);
  assert.equal(answer.error, dapp.DAPP_MAYBE_SENT_ERROR);
  assert.ok(Date.now() - started >= dapp.DAPP_CLAIM_GRACE_MS, "the grace period was waited out");
  assert.deepEqual((await dapp.listPending()).map((entry) => entry.id), ["busy"]);
  assert.equal(await dapp.resolveRequest("busy", hash, outcome.claim), true);
});

test("a claimed row answered during the grace period gives the dapp its hash", async () => {
  await reset();
  await queued("slow");
  const outcome = await dapp.claimPendingRequest("slow");
  assert.ok("claim" in outcome);
  const waiting = dapp.awaitResolution("slow", 20);
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(await dapp.resolveRequest("slow", hash, outcome.claim), true);
  const answer = await waiting;
  assert.equal(answer.result, hash);
  assert.equal(answer.code, undefined);
});

test("expiry of a row tells claimed and unclaimed apart, under the queue lock", async () => {
  await reset();
  await queued("open");
  await queued("held");
  const outcome = await dapp.claimPendingRequest("held");
  assert.ok("claim" in outcome);
  assert.equal(await dapp.expirePending("open"), "dropped");
  assert.equal(await dapp.expirePending("held"), "claimed");
  assert.equal(await dapp.expirePending("open"), "missing");
  assert.deepEqual((await dapp.listPending()).map((entry) => entry.id), ["held"]);
});

test("a gone tab's unclaimed rows are taken atomically and a claimed one stays", async () => {
  await reset();
  await queued("page", Date.now(), { tabId: 5 });
  await queued("frame", Date.now(), { tabId: 5, kind: "sign", tx: undefined, message: "hi" });
  await queued("sent", Date.now(), { tabId: 5 });
  await queued("elsewhere", Date.now(), { tabId: 6 });
  assert.ok("claim" in await dapp.claimPendingRequest("sent"));
  const gone = await dapp.takeTabRequests(5);
  assert.deepEqual(gone.map((entry) => entry.id), ["page", "frame"]);
  assert.deepEqual((await dapp.listPending()).map((entry) => entry.id), ["sent", "elsewhere"]);
  // The stored rows keep their tab, so a reloaded worker still knows it.
  assert.equal((await dapp.listPending())[1]?.tabId, 6);
});
