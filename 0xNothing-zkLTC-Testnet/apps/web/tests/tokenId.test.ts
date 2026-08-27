import assert from "node:assert/strict";
import test from "node:test";
import { normalizeUint256TokenId } from "../lib/tokenId.ts";

const MAX_UINT256 = (1n << 256n) - 1n;

test("normalizeUint256TokenId canonicalizes valid identifiers", () => {
  assert.equal(normalizeUint256TokenId("00042"), "42");
  assert.equal(normalizeUint256TokenId(MAX_UINT256.toString()), MAX_UINT256.toString());
});

test("normalizeUint256TokenId rejects out-of-range and attacker-sized values", () => {
  assert.equal(normalizeUint256TokenId((MAX_UINT256 + 1n).toString()), undefined);
  assert.equal(normalizeUint256TokenId("9".repeat(10_000)), undefined);
  assert.equal(normalizeUint256TokenId("-1"), undefined);
});
