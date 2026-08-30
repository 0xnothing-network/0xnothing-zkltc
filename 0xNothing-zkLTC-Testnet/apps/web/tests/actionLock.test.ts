import assert from "node:assert/strict";
import test from "node:test";
import { releaseAction, tryAcquireAction, type ActionLock } from "../lib/actionLock.ts";

test("an action lock admits only one synchronous caller", () => {
  const lock: ActionLock = { current: false };

  assert.equal(tryAcquireAction(lock), true);
  assert.equal(tryAcquireAction(lock), false);
  assert.equal(lock.current, true);
});

test("an action lock can be acquired again after release", () => {
  const lock: ActionLock = { current: false };

  assert.equal(tryAcquireAction(lock), true);
  releaseAction(lock);
  assert.equal(tryAcquireAction(lock), true);
});
