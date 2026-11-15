import assert from "node:assert/strict";
import { test } from "node:test";
import {
  approvalView,
  DAPP_APPROVAL_EXECUTION_BUDGET_MS,
  DAPP_MAYBE_SENT_ERROR,
  DAPP_REQUEST_TIMEOUT_MS,
  DAPP_SIGN_RESERVE_MS,
  expiryAnswer,
  MAX_PENDING_CONNECTS,
  MAX_PENDING_PER_ORIGIN,
  MAX_PENDING_PER_TAB,
  MAX_PENDING_REQUESTS,
  type DappRequest,
  liveResolutions,
  planPendingAdmission,
  planPendingClaim,
  planPendingClaimRelease,
  planStalePending,
  planTabGone,
  sanitizePendingRequests,
  tabDocuments,
  unclaimedNotice,
} from "../../src/core/services/dapp.ts";

function request(
  id: string,
  origin: string,
  kind: DappRequest["kind"] = "transaction",
  at = 1_000_000,
): DappRequest {
  return { id, origin, kind, at };
}

test("a site cannot stack duplicate connection prompts", () => {
  const first = request("first", "https://app.example", "connect");
  const result = planPendingAdmission(
    [first],
    request("second", "https://app.example", "connect"),
    first.at + 1,
  );
  assert.deepEqual(result, { accepted: false, reason: "duplicate-connect" });
});

test("pending admission bounds one origin and the global queue", () => {
  const perOrigin = Array.from({ length: MAX_PENDING_PER_ORIGIN }, (_, index) =>
    request(`same-${index}`, "https://app.example")
  );
  assert.deepEqual(
    planPendingAdmission(perOrigin, request("overflow", "https://app.example"), 1_000_001),
    { accepted: false, reason: "origin-limit" },
  );

  const global = Array.from({ length: MAX_PENDING_REQUESTS }, (_, index) =>
    request(`global-${index}`, `https://app-${index}.example`)
  );
  assert.deepEqual(
    planPendingAdmission(global, request("overflow", "https://overflow.example"), 1_000_001),
    { accepted: false, reason: "queue-limit" },
  );
});

test("an expired orphan is pruned before a fresh request is queued", () => {
  const now = 2_000_000;
  const expired = request(
    "expired",
    "https://old.example",
    "sign",
    now - DAPP_REQUEST_TIMEOUT_MS,
  );
  const fresh = request("fresh", "https://new.example", "sign", now);
  const result = planPendingAdmission([expired], fresh, now);
  assert.equal(result.accepted, true);
  if (!result.accepted) return;
  assert.deepEqual(result.expiredIds, [expired.id]);
  assert.deepEqual(result.queue, [fresh]);
});

test("a restarted worker drops unclaimed rows from its previous life", () => {
  const bootedAt = 2_000_000;
  const orphan = request("orphan", "https://old.example", "transaction", bootedAt - 1);
  const claimed = { ...request("claimed", "https://old.example", "sign", bootedAt - 1), approvalClaim: "7d1f7a7e-1c4b-4e8a-9a51-3c2b1d0e9f8a" };
  const arrived = request("arrived", "https://new.example", "sign", bootedAt);
  const expired = request("expired", "https://old.example", "sign", bootedAt - DAPP_REQUEST_TIMEOUT_MS);
  const { fresh, stale } = planStalePending([orphan, claimed, arrived, expired], bootedAt + 5, bootedAt);
  assert.deepEqual(fresh.map((entry) => entry.id), ["claimed", "arrived"]);
  assert.deepEqual(stale.map((entry) => entry.id), ["orphan", "expired"]);
  // Without a boot time only expiry counts, as before.
  assert.deepEqual(planStalePending([orphan, expired], bootedAt + 5).stale.map((entry) => entry.id), ["expired"]);
});

test("an answer no worker can still be waiting for is not kept", () => {
  const now = 10_000_000;
  const kept = liveResolutions([
    { id: "fresh", result: "0xsig", at: now - 1_000 },
    { id: "clock-stepped-back", result: "0xsig", at: now + 500 },
    { id: "aged", result: "0xsig", at: now - DAPP_REQUEST_TIMEOUT_MS },
    { id: "untimed", result: "0xsig" },
  ], now);
  assert.deepEqual(kept.map((entry) => entry.id), ["fresh", "clock-stepped-back"]);
});

test("only one approval window can claim a persisted request", () => {
  const now = 1_000_001;
  const pending = request("tx-1", "https://app.example");
  const firstToken = "11111111-1111-4111-8111-111111111111";
  const secondToken = "22222222-2222-4222-8222-222222222222";
  const first = planPendingClaim([pending], pending.id, firstToken, now);
  assert.equal(first.accepted, true);
  if (!first.accepted) return;
  assert.equal(first.queue[0]?.approvalClaim, firstToken);
  assert.deepEqual(
    planPendingClaim(first.queue, pending.id, secondToken, now),
    { accepted: false, reason: "claimed" },
  );
  assert.deepEqual(
    planPendingClaim([pending], pending.id, "not-a-uuid", now),
    { accepted: false, reason: "invalid-claim" },
  );
});

test("approval execution cannot start without enough request-timeout headroom", () => {
  const now = 2_000_000;
  const token = "11111111-1111-4111-8111-111111111111";
  const atBoundary = request(
    "boundary",
    "https://app.example",
    "transaction",
    now - DAPP_REQUEST_TIMEOUT_MS + DAPP_APPROVAL_EXECUTION_BUDGET_MS,
  );
  assert.equal(planPendingClaim([atBoundary], atBoundary.id, token, now).accepted, true);
  assert.deepEqual(
    planPendingClaim(
      [{ ...atBoundary, id: "too-late", at: atBoundary.at - 1 }],
      "too-late",
      token,
      now,
    ),
    { accepted: false, reason: "expired" },
  );
});

test("only the owning approval window can release its claim", () => {
  const token = "11111111-1111-4111-8111-111111111111";
  const pending = { ...request("tx-1", "https://app.example"), approvalClaim: token };
  const wrong = planPendingClaimRelease(
    [pending],
    pending.id,
    "22222222-2222-4222-8222-222222222222",
  );
  assert.equal(wrong.released, false);
  assert.equal(wrong.queue[0]?.approvalClaim, token);

  const owner = planPendingClaimRelease([pending], pending.id, token);
  assert.equal(owner.released, true);
  assert.equal(owner.queue[0]?.approvalClaim, undefined);
});

test("persisted approval rows are validated before the UI or worker uses them", () => {
  const valid = {
    id: "request-1",
    origin: "https://app.example",
    kind: "transaction",
    at: Date.now(),
    networkId: "litvm-4441",
    account: "0x1111111111111111111111111111111111111111",
    tx: {
      to: "0x2222222222222222222222222222222222222222",
      value: "0x1",
      data: "0x",
    },
  };
  const sanitized = sanitizePendingRequests([valid]);
  assert.equal(sanitized.length, 1);
  assert.equal(sanitized[0]?.id, valid.id);
  assert.equal(sanitized[0]?.tx?.value, "0x1");
  const claimed = sanitizePendingRequests([{
    ...valid,
    approvalClaim: "11111111-1111-4111-8111-111111111111",
  }]);
  assert.equal(claimed[0]?.approvalClaim, "11111111-1111-4111-8111-111111111111");
  assert.deepEqual(sanitizePendingRequests([
    { ...valid, origin: "chrome-extension://hostile" },
    { ...valid, account: "not-an-address" },
    { ...valid, tx: { data: `0x${"00".repeat(1_000_001)}` } },
    { ...valid, approvalClaim: "not-a-uuid" },
    null,
  ]), []);
});

const CLAIM = "11111111-1111-4111-8111-111111111111";

test("a window that cannot claim says why instead of closing, and answers only an expired row", () => {
  assert.deepEqual(unclaimedNotice("expired", false), { notice: "apr.expired", rejectExpired: true });
  // A missing row was mostly answered by the worker (page gone, sweep, timeout),
  // so the notice names no cause.
  assert.deepEqual(unclaimedNotice("missing", false), { notice: "apr.gone", rejectExpired: false });
  assert.deepEqual(unclaimedNotice("missing", true), { notice: "apr.gone", rejectExpired: false });
  assert.deepEqual(unclaimedNotice("claimed", false), { notice: "apr.alreadyHandled", rejectExpired: false });
  assert.deepEqual(unclaimedNotice("invalid-claim", false), { notice: "apr.alreadyHandled", rejectExpired: false });
  // A transaction this window signed and still holds may be out.
  assert.deepEqual(unclaimedNotice("claimed", true), { notice: "apr.maybeSent", rejectExpired: false });
});

test("one tab cannot hold more than its share of the queue, across any number of origins", () => {
  const now = 1_000_001;
  const tab = Array.from({ length: MAX_PENDING_PER_TAB }, (_, index) => ({
    ...request(`frame-${index}`, `https://s${index}.evil.example`, "sign"),
    tabId: 7,
  }));
  assert.deepEqual(
    planPendingAdmission(tab, { ...request("fifth", "https://s9.evil.example", "sign"), tabId: 7 }, now),
    { accepted: false, reason: "tab-limit" },
  );
  // Another tab, and a 1.0.9 row without a tab, are not counted against it.
  assert.equal(planPendingAdmission(tab, { ...request("other", "https://app.example"), tabId: 8 }, now).accepted, true);
  assert.equal(planPendingAdmission(tab, request("untabbed", "https://app.example"), now).accepted, true);
});

test("unconnected sites cannot fill the queue with connects, and a connected site still gets in", () => {
  const now = 1_000_001;
  const connects = Array.from({ length: MAX_PENDING_CONNECTS }, (_, index) => ({
    ...request(`connect-${index}`, `https://s${index}.evil.example`, "connect"),
    tabId: index,
  }));
  assert.deepEqual(
    planPendingAdmission(connects, { ...request("seventh", "https://s99.evil.example", "connect"), tabId: 99 }, now),
    { accepted: false, reason: "connect-limit" },
  );
  const tx = planPendingAdmission(connects, { ...request("tx", "https://defi.example"), tabId: 100 }, now);
  assert.equal(tx.accepted, true);
  assert.ok(MAX_PENDING_REQUESTS - MAX_PENDING_CONNECTS >= 18);
});

test("a claimed row outlives the timeout by the execution budget and is then answered as maybe sent", () => {
  const at = 1_000_000;
  const claimed = { ...request("claimed", "https://app.example"), approvalClaim: CLAIM };
  const unclaimed = request("unclaimed", "https://other.example");
  const next = request("next", "https://new.example");
  const at241 = planPendingAdmission([claimed, unclaimed], next, at + 241_000);
  assert.equal(at241.accepted, true);
  if (!at241.accepted) return;
  assert.deepEqual(at241.queue.map((entry) => entry.id), ["claimed", "next"]);
  assert.deepEqual(at241.expiredIds, ["unclaimed"]);
  assert.deepEqual(at241.maybeSentIds, []);
  const at301 = planPendingAdmission([claimed], next, at + 301_000);
  assert.equal(at301.accepted, true);
  if (!at301.accepted) return;
  assert.deepEqual(at301.expiredIds, ["claimed"]);
  assert.deepEqual(at301.maybeSentIds, ["claimed"]);
  // The unclaimed row still goes at exactly the timeout.
  const at240 = planPendingAdmission([unclaimed], next, at + DAPP_REQUEST_TIMEOUT_MS);
  assert.equal(at240.accepted && at240.expiredIds[0], "unclaimed");

  const stale241 = planStalePending([claimed, unclaimed], at + 241_000);
  assert.deepEqual(stale241.fresh.map((entry) => entry.id), ["claimed"]);
  assert.deepEqual(stale241.stale.map((entry) => entry.id), ["unclaimed"]);
  const limit = at + DAPP_REQUEST_TIMEOUT_MS + DAPP_APPROVAL_EXECUTION_BUDGET_MS;
  assert.deepEqual(planStalePending([claimed], limit - 1).fresh.map((entry) => entry.id), ["claimed"]);
  assert.deepEqual(planStalePending([claimed], limit).stale.map((entry) => entry.id), ["claimed"]);
  assert.deepEqual(planStalePending([claimed], at + 301_000).stale.map((entry) => entry.id), ["claimed"]);

  assert.deepEqual(expiryAnswer(unclaimed), { error: "Request expired", code: 4001 });
  assert.deepEqual(expiryAnswer(claimed), { error: DAPP_MAYBE_SENT_ERROR, code: -32603 });
  assert.doesNotMatch(DAPP_MAYBE_SENT_ERROR, /reject/iu);
});

test("the time budgets fit inside each other and inside the page's own timeout", () => {
  // claim needs the budget left, signing needs the reserve left, so preparing gets the gap.
  assert.ok(DAPP_SIGN_RESERVE_MS < DAPP_APPROVAL_EXECUTION_BUDGET_MS);
  assert.ok(DAPP_APPROVAL_EXECUTION_BUDGET_MS - DAPP_SIGN_RESERVE_MS >= 20_000);
});

test("a gone tab loses its unclaimed rows; claimed rows, other tabs and untabbed rows stay", () => {
  const queue: DappRequest[] = [
    { ...request("connect", "https://app.example", "connect"), tabId: 3 },
    { ...request("sign", "https://frame.example", "sign"), tabId: 3 },
    { ...request("claimed", "https://app.example"), tabId: 3, approvalClaim: CLAIM },
    { ...request("other-tab", "https://app.example", "sign"), tabId: 4 },
    request("untabbed", "https://app.example", "sign"),
  ];
  const { fresh, gone } = planTabGone(queue, 3);
  assert.deepEqual(gone.map((entry) => entry.id), ["connect", "sign"]);
  assert.deepEqual(fresh.map((entry) => entry.id), ["claimed", "other-tab", "untabbed"]);
  assert.deepEqual(planTabGone(queue, 9).gone, []);
});

test("a stored tab id is kept only when it is a browser tab id, and 1.0.9 rows still read", () => {
  const valid = {
    id: "request-1",
    origin: "https://app.example",
    kind: "sign",
    at: Date.now(),
    account: "0x1111111111111111111111111111111111111111",
    message: "hello",
  };
  assert.equal(sanitizePendingRequests([{ ...valid, tabId: 12 }])[0]?.tabId, 12);
  assert.equal(sanitizePendingRequests([{ ...valid, tabId: 0 }])[0]?.tabId, 0);
  for (const tabId of [-1, 1.5, "12", Number.NaN, null]) {
    const [row] = sanitizePendingRequests([{ ...valid, tabId }]);
    assert.equal(row?.id, valid.id, String(tabId));
    assert.equal("tabId" in (row ?? {}), false, String(tabId));
  }
  const [old] = sanitizePendingRequests([valid]);
  assert.equal(old?.id, valid.id);
  assert.equal("tabId" in (old ?? {}), false);
});

const DOC_A = "0123456789ABCDEF0123456789ABCDEF";
const DOC_B = "FEDCBA9876543210FEDCBA9876543210";
const DOC_NEW = "00000000000000000000000000000001";

test("a loaded tab loses only the rows whose document did not answer", () => {
  const queue: DappRequest[] = [
    { ...request("old-page", "https://app.example", "connect"), tabId: 3, documentId: DOC_A },
    { ...request("same-page", "https://app.example", "sign"), tabId: 3, documentId: DOC_B },
    { ...request("claimed", "https://app.example"), tabId: 3, documentId: DOC_A, approvalClaim: CLAIM },
    { ...request("no-document", "https://app.example", "sign"), tabId: 3 },
    { ...request("other-tab", "https://app.example", "sign"), tabId: 4, documentId: DOC_A },
    // Queued after the documents were asked: its page is the new, live one.
    { ...request("arrived-later", "https://app.example", "sign"), tabId: 3, documentId: DOC_NEW },
  ];
  // Only the unclaimed rows of that tab that name a document are asked about, once each.
  assert.deepEqual(tabDocuments(queue, 3), [DOC_A, DOC_B, DOC_NEW]);
  assert.deepEqual(tabDocuments(queue, 4), [DOC_A]);
  assert.deepEqual(tabDocuments(queue, 9), []);

  // A pushState: every asked document answered, so only the row without one goes.
  const pushState = planTabGone(queue, 3, new Set());
  assert.deepEqual(pushState.gone.map((entry) => entry.id), ["no-document"]);
  // A real navigation: the old document did not answer.
  const navigated = planTabGone(queue, 3, new Set([DOC_A]));
  assert.deepEqual(navigated.gone.map((entry) => entry.id), ["old-page", "no-document"]);
  assert.deepEqual(
    navigated.fresh.map((entry) => entry.id),
    ["same-page", "claimed", "other-tab", "arrived-later"],
  );
  // A closed tab, asked nothing, loses every unclaimed row it had.
  assert.deepEqual(planTabGone(queue, 3).gone.map((entry) => entry.id), ["old-page", "same-page", "no-document", "arrived-later"]);
});

test("a stored document id is kept only in Chromium's shape, and rows without one still read", () => {
  const valid = {
    id: "request-1",
    origin: "https://app.example",
    kind: "sign",
    at: Date.now(),
    account: "0x1111111111111111111111111111111111111111",
    message: "hello",
    tabId: 5,
  };
  assert.equal(sanitizePendingRequests([{ ...valid, documentId: DOC_A }])[0]?.documentId, DOC_A);
  assert.equal(sanitizePendingRequests([{ ...valid, documentId: DOC_A.toLowerCase() }])[0]?.documentId, DOC_A.toLowerCase());
  for (const documentId of [`${DOC_A}0`, DOC_A.slice(1), "G".repeat(32), 12, null, { id: DOC_A }]) {
    const [row] = sanitizePendingRequests([{ ...valid, documentId }]);
    assert.equal(row?.id, valid.id, String(documentId));
    assert.equal("documentId" in (row ?? {}), false, String(documentId));
  }
  // A 1.0.9 row has neither a tab nor a document.
  const { tabId: _tab, ...old } = valid;
  const [read] = sanitizePendingRequests([old]);
  assert.equal(read?.id, valid.id);
  assert.equal("documentId" in (read ?? {}), false);
});

test("an approval window shows only rows it can act on, so a row claimed elsewhere cannot trap it", () => {
  const elsewhere = { ...request("elsewhere", "https://a.example"), approvalClaim: CLAIM };
  const unclaimed = request("unclaimed", "https://b.example", "sign");
  const nobody = () => false;
  // The window was opened for a request now answered; the claimed row is skipped.
  const view = approvalView([elsewhere, unclaimed], "answered", nobody);
  assert.equal(view.request?.id, "unclaimed");
  assert.deepEqual(view.actionable.map((entry) => entry.id), ["unclaimed"]);
  // Even when it is the one the window was opened with.
  assert.equal(approvalView([elsewhere, unclaimed], "elsewhere", nobody).request?.id, "unclaimed");
  // Nothing left to act on: the window has nothing to show and closes.
  assert.deepEqual(approvalView([elsewhere], "elsewhere", nobody), { request: null, actionable: [] });
  // A claim this window holds (a signed transaction, or the one it is working on) stays shown.
  const mine = approvalView([elsewhere, unclaimed], "elsewhere", (id) => id === "elsewhere");
  assert.equal(mine.request?.id, "elsewhere");
  assert.equal(mine.actionable.length, 2);
  assert.deepEqual(approvalView([], null, nobody), { request: null, actionable: [] });
});
