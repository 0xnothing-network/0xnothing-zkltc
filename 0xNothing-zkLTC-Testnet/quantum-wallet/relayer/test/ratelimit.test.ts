// SPDX-License-Identifier: MIT
// RateLimiter guardrails. The window logic is trivial; what these lock down is
// the *bound*: a caller chooses the limiter key, so the map must not grow with
// the number of distinct keys ever seen (memory-exhaustion DoS).
//
// Time is always passed explicitly via the `now` argument — the limiter takes it
// as a parameter precisely so this is testable without sleeping.

import assert from "node:assert/strict";
import test from "node:test";
import { RateLimiter } from "../src/server.ts";

const T0 = 1_700_000_000_000;
const WINDOW = 60_000;

test("allows up to max inside the window, then refuses", () => {
  const rl = new RateLimiter(3, WINDOW);
  assert.equal(rl.allow("w", T0), true);
  assert.equal(rl.allow("w", T0 + 1), true);
  assert.equal(rl.allow("w", T0 + 2), true);
  assert.equal(rl.allow("w", T0 + 3), false);
  assert.equal(rl.count("w"), 3);
  // The window slides: the first three hits have aged out.
  assert.equal(rl.allow("w", T0 + WINDOW), true);
});

test("keys that stop asking are swept, not retained forever", () => {
  const rl = new RateLimiter(5, WINDOW);
  for (let i = 0; i < 500; i++) assert.equal(rl.allow(`throwaway-${i}`, T0), true);
  assert.equal(rl.size(), 500);

  // One window later a sweep runs before the new key is recorded, and none of
  // the throwaway keys has a hit still inside the window.
  rl.allow("live", T0 + WINDOW);
  assert.equal(rl.size(), 1, "expired keys must be dropped");
});

test("a repeatedly-refused key does not keep growing", () => {
  const rl = new RateLimiter(2, WINDOW);
  for (let i = 0; i < 40; i++) {
    // All 40 hits land inside one window, so every call after the second is
    // refused — and the pruned array must be written back in that branch too.
    assert.equal(rl.allow("hot", T0 + i), i < 2);
  }
  assert.equal(rl.count("hot"), 2);
});

test("separate keys have separate budgets", () => {
  const rl = new RateLimiter(1, WINDOW);
  assert.equal(rl.allow("a", T0), true);
  assert.equal(rl.allow("b", T0), true, "b must not be charged for a's hit");
  assert.equal(rl.allow("a", T0 + 1), false);
});
