import assert from "node:assert/strict";
import { test } from "node:test";
import { createSlidingWindowRateLimiter } from "../lib/server/slidingWindowRateLimit.ts";

test("multi-identity admission is atomic when one quota is full", () => {
  const limiter = createSlidingWindowRateLimiter({
    windowMs: 1_000,
    maxAttempts: 2,
    maxKeys: 8,
  });

  assert.equal(limiter.consume(["ip:shared"], 100), true);
  assert.equal(limiter.consume(["ip:shared"], 200), true);
  assert.equal(limiter.consume(["wallet:new", "ip:shared"], 300), false);

  // The rejected combined request must not spend the wallet's independent quota.
  assert.equal(limiter.consume(["wallet:new"], 400), true);
  assert.equal(limiter.consume(["wallet:new"], 500), true);
  assert.equal(limiter.consume(["wallet:new"], 600), false);
});

test("active shared identities survive bounded-key churn", () => {
  const limiter = createSlidingWindowRateLimiter({
    windowMs: 10_000,
    maxAttempts: 3,
    maxKeys: 3,
  });

  assert.equal(limiter.consume(["wallet:1", "ip:shared"], 100), true);
  assert.equal(limiter.consume(["wallet:2", "ip:shared"], 200), true);
  assert.equal(limiter.consume(["wallet:3", "ip:shared"], 300), true);
  assert.equal(limiter.size(), 3);
  assert.equal(limiter.consume(["wallet:4", "ip:shared"], 400), false);
  assert.equal(limiter.size(), 3);
});

test("expired windows are pruned and quotas reopen", () => {
  const limiter = createSlidingWindowRateLimiter({
    windowMs: 100,
    maxAttempts: 1,
    maxKeys: 2,
  });

  assert.equal(limiter.consume(["wallet:1"], 10), true);
  assert.equal(limiter.consume(["wallet:1"], 50), false);
  limiter.prune(111);
  assert.equal(limiter.size(), 0);
  assert.equal(limiter.consume(["wallet:1"], 111), true);
});

test("invalid limiter options fail closed during construction", () => {
  assert.throws(() => createSlidingWindowRateLimiter({ windowMs: 0, maxAttempts: 1, maxKeys: 1 }));
  assert.throws(() => createSlidingWindowRateLimiter({ windowMs: 1, maxAttempts: 0, maxKeys: 1 }));
  assert.throws(() => createSlidingWindowRateLimiter({ windowMs: 1, maxAttempts: 1, maxKeys: 0 }));
});
