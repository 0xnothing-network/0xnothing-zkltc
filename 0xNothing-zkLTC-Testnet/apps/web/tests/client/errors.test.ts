import assert from "node:assert/strict";
import test from "node:test";
import { normalizeError } from "../../lib/errors.ts";

test("malformed wallet error fields cannot break the notification path", () => {
  for (const value of [{ message: 123 }, { reason: {} }, { shortMessage: ["bad"] }, Object.create(null)]) {
    assert.equal(typeof normalizeError(value).title, "string");
  }
});

test("nested and cyclic wallet errors preserve rejection and connectivity meaning", () => {
  const rejection = { message: "Provider request failed", cause: { code: 4001 } };
  assert.equal(normalizeError(rejection).title, "Request canceled");
  assert.equal(normalizeError({ cause: { code: "4900" } }).title, "Network unreachable");
  const cyclic: { message: string; cause?: unknown } = { message: "Something else" };
  cyclic.cause = cyclic;
  assert.equal(normalizeError(cyclic).title, "Something else");
});

test("amounts and addresses containing HTTP status digits are not network failures", () => {
  assert.equal(normalizeError(new Error("Insufficient funds for 500 tokens")).title, "Insufficient balance");
  assert.equal(normalizeError(new Error("Request failed (HTTP 503)")).title, "Network unreachable");
});
