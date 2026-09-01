import assert from "node:assert/strict";
import test from "node:test";
import { formatFixedAmount } from "../../features/fi/lib/format.ts";

test("fixed amounts round half-up to exactly two decimals", () => {
  assert.equal(formatFixedAmount(0n), "0.00");
  assert.equal(formatFixedAmount(1_234_000_000_000_000_000n), "1.23");
  assert.equal(formatFixedAmount(1_235_000_000_000_000_000n), "1.24");
  assert.equal(formatFixedAmount(5_000_000_000_000_000n), "0.01");
});

test("fixed amounts preserve precision beyond Number safe integers", () => {
  assert.equal(
    formatFixedAmount(12_345_678_901_234_567_895_000_000_000_000_000n),
    "12,345,678,901,234,567.90",
  );
});

test("point-credit storage converts directly to the public xPoints precision", () => {
  assert.equal(formatFixedAmount(1_000_000_000_000_000_000n, 20), "0.01");
  assert.equal(formatFixedAmount(100_000_000_000_000_000_000n, 20), "1.00");
});
