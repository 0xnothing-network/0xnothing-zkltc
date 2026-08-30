import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DAPP_REQUEST_TIMEOUT_MS,
  MAX_PENDING_PER_ORIGIN,
  MAX_PENDING_REQUESTS,
  type DappRequest,
  planPendingAdmission,
  sanitizePendingRequests,
} from "../src/core/services/dapp.ts";

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
  assert.deepEqual(sanitizePendingRequests([
    { ...valid, origin: "chrome-extension://hostile" },
    { ...valid, account: "not-an-address" },
    { ...valid, tx: { data: `0x${"00".repeat(1_000_001)}` } },
    null,
  ]), []);
});
