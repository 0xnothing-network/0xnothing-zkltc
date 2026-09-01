import assert from "node:assert/strict";
import test from "node:test";
import {
  compareDecimalStrings,
  decimalMax,
  decimalMin,
} from "../../features/pump/decimal.ts";

test("decimal comparison remains exact above Number's safe range", () => {
  assert.equal(compareDecimalStrings("9007199254740992", "9007199254740993"), -1);
  assert.equal(decimalMax("9007199254740992", "9007199254740993"), "9007199254740993");
  assert.equal(decimalMin("9007199254740992", "9007199254740993"), "9007199254740992");
});

test("decimal comparison handles long fractions, zeros, and huge values", () => {
  assert.equal(compareDecimalStrings("1.0000000000000000001", "1.0000000000000000000"), 1);
  assert.equal(compareDecimalStrings("0001.2300", "1.23"), 0);
  assert.equal(decimalMax("9".repeat(400), "1" + "0".repeat(400)), "1" + "0".repeat(400));
});

test("decimal min and max retain the left value for malformed input", () => {
  assert.equal(decimalMax("invalid", "2"), "invalid");
  assert.equal(decimalMin("1", "invalid"), "1");
});
