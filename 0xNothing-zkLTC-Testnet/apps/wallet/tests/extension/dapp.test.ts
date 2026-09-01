import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DAPP_APPROVAL_EXECUTION_BUDGET_MS,
  DAPP_REQUEST_TIMEOUT_MS,
  MAX_PENDING_PER_ORIGIN,
  MAX_PENDING_REQUESTS,
  type DappRequest,
  planPendingAdmission,
  planPendingClaim,
  planPendingClaimRelease,
  sanitizePendingRequests,
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
