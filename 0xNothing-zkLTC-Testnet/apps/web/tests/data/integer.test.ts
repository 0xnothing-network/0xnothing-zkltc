import assert from "node:assert/strict";
import test from "node:test";
import { hasPositiveBigInt, nonNegativeBigInt } from "../../lib/integer.ts";

test("nonNegativeBigInt rejects malformed and negative indexer values", () => {
  assert.equal(nonNegativeBigInt("123456789012345678901234567890"), 123456789012345678901234567890n);
  assert.equal(nonNegativeBigInt("not-a-number"), undefined);
  assert.equal(nonNegativeBigInt("0x10"), undefined);
  assert.equal(nonNegativeBigInt(undefined), undefined);
  assert.equal(nonNegativeBigInt("-1"), undefined);
  assert.equal(nonNegativeBigInt("1.5"), undefined);
});

test("hasPositiveBigInt tolerates malformed values without hiding valid liquidity", () => {
  assert.equal(hasPositiveBigInt("broken", "0", "2"), true);
  assert.equal(hasPositiveBigInt("broken", "0", undefined), false);
});
