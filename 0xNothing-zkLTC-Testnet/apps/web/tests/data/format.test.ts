import assert from "node:assert/strict";
import test from "node:test";
import { formatFixedAmount, formatUnlockTime, parseAmount } from "../../features/fi/lib/format.ts";

test("LP unlock dates preserve valid uint64 values outside the Date range", () => {
  assert.equal(formatUnlockTime(undefined), "--");
  assert.equal(formatUnlockTime(0n), "Jan 1, 1970, 12:00 AM UTC");
  assert.doesNotThrow(() => formatUnlockTime(8_640_000_000_000n));
  assert.equal(formatUnlockTime(8_640_000_000_001n), "Unix 8640000000001 seconds");
  assert.equal(formatUnlockTime((1n << 64n) - 1n), "Unix 18446744073709551615 seconds");
});

test("transaction amounts never round unsupported token precision", () => {
  assert.equal(parseAmount("1.0000009", 6), undefined);
  assert.equal(parseAmount("1.5", 0), undefined);
  assert.equal(parseAmount("0.0000000000000000009"), undefined);
  assert.equal(parseAmount("1.0000000", 6), 1_000_000n);
  assert.equal(parseAmount(".5", 6), 500_000n);
  assert.equal(parseAmount("1.0", 0), 1n);
});

test("transaction amounts reject invalid scales and uint256 overflow", () => {
  assert.equal(parseAmount("1", -1), undefined);
  assert.equal(parseAmount("1", 256), undefined);
  assert.equal(parseAmount("1", 1.5), undefined);
  assert.equal(parseAmount(((1n << 256n) - 1n).toString(), 0), (1n << 256n) - 1n);
  assert.equal(parseAmount((1n << 256n).toString(), 0), undefined);
});

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
