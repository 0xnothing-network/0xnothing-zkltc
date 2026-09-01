import assert from "node:assert/strict";
import { test } from "node:test";
import {
  formatAmount,
  formatBalance,
  formatRateWad,
  formatSignedPercent,
  formatTimeAgo,
  formatUsdWad,
  parseAmount,
  shortenAddress,
  usdValueWad,
  WAD,
} from "../../src/core/lib/format.ts";

/**
 * The number formatting every screen depends on. These are the cases that would
 * misread as money: a dust balance collapsing to "0", a total rounding the wrong
 * way at the half cent, and an input the user is still typing.
 */
test("amounts group thousands and drop trailing zeros", () => {
  assert.equal(formatAmount(1_000n * WAD, 18), "1,000");
  assert.equal(formatAmount(1_234_567n * WAD, 18), "1,234,567");
  assert.equal(formatAmount(WAD / 2n, 18), "0.5");
  assert.equal(formatAmount(0n, 18), "0");
  assert.equal(formatAmount(1n, 18, 6), "0");
});

test("balances keep small numbers visible", () => {
  assert.equal(formatBalance(0n, 18), "0");
  assert.equal(formatBalance(12_345n * WAD, 18), "12,345");
  assert.equal(formatBalance(WAD * 3n / 2n, 18), "1.5");
  assert.equal(formatBalance(WAD / 1_000_000n, 18), "0.000001");
  // Below 1e-4 the extra digits are what stop dust reading as zero…
  assert.equal(formatBalance(WAD / 100_000_000n, 18), "0.00000001");
  // …but eight is where it stops. Wei-sized dust does read as "0", and no
  // number of digits would make it mean anything on a balance row.
  assert.equal(formatBalance(123_456_789n, 18), "0");
});

test("usd rounds at the half cent and keeps the sign", () => {
  assert.equal(formatUsdWad(0n), "$0.00");
  assert.equal(formatUsdWad(WAD), "$1.00");
  assert.equal(formatUsdWad(1_000n * WAD), "$1,000.00");
  assert.equal(formatUsdWad(WAD * 5n / 1000n), "$0.01");
  assert.equal(formatUsdWad(-WAD * 25n / 10n), "-$2.50");
});

test("percent and rate helpers", () => {
  assert.equal(formatSignedPercent(0), "0.00%");
  assert.equal(formatSignedPercent(0.0512), "+5.12%");
  assert.equal(formatSignedPercent(-0.0512), "-5.12%");
  assert.equal(formatSignedPercent(Number.NaN), "--");
  assert.equal(formatRateWad(WAD * 4n / 100n), "4.00%");
  assert.equal(formatRateWad(0n), "0.00%");
});

test("parseAmount refuses anything that is not a plain decimal", () => {
  assert.equal(parseAmount("1.5", 18), WAD * 3n / 2n);
  assert.equal(parseAmount("1,500", 18), 1_500n * WAD);
  assert.equal(parseAmount("", 18), null);
  assert.equal(parseAmount("-1", 18), null);
  assert.equal(parseAmount("1e18", 18), null);
  assert.equal(parseAmount("0x10", 18), null);
  // A lone separator is not an amount yet, but a leading one is.
  assert.equal(parseAmount(".", 18), null);
  assert.equal(parseAmount(".5", 18), WAD / 2n);
  // Extra decimals are the user's typing, not a reason to reject the field.
  assert.equal(parseAmount("0.0000000000000000001", 18), 0n);
});

test("usd value scales by the token's own decimals", () => {
  assert.equal(usdValueWad(2n * WAD, 18, 3n * WAD), 6n * WAD);
  assert.equal(usdValueWad(1_000_000n, 6, 2n * WAD), 2n * WAD);
});

test("addresses shorten from both ends", () => {
  const address = "0x8dd79c3966c8392b08b609FAEce029c3329f9E9E";
  assert.equal(shortenAddress(address), "0x8dd7…9E9E");
  assert.equal(shortenAddress(address, 10, 6), "0x8dd79c39…9f9E9E");
  assert.equal(shortenAddress("0x1234", 6, 4), "0x1234");
});

test("time ago stays in one unit", () => {
  const now = 1_700_000_000_000;
  assert.equal(formatTimeAgo(now, now), "0s");
  assert.equal(formatTimeAgo(now - 45_000, now), "45s");
  assert.equal(formatTimeAgo(now - 120_000, now), "2m");
  assert.equal(formatTimeAgo(now - 7_200_000, now), "2h");
  assert.equal(formatTimeAgo(now - 172_800_000, now), "2d");
  // A clock that is behind the record must not print a negative age.
  assert.equal(formatTimeAgo(now + 5_000, now), "0s");
});
