import assert from "node:assert/strict";
import { test } from "node:test";
import { WAD } from "../../src/core/lib/format.ts";
import {
  applySlippage,
  endToEndMinOut,
  fallbackNativeReserve,
  NATIVE_GAS_RESERVE_WEI,
  nativeSendMax,
  QUOTE_MAX_AGE_MS,
  quoteFresh,
  quoteMatches,
  spendableForSwap,
} from "../../src/core/lib/swapMath.ts";

/**
 * Two numbers decide whether a swap costs the user more than they agreed to:
 * what MAX spends, and how far below the quote the transaction may settle.
 */
test("the gas reserve is a hundredth of a coin", () => {
  // Pinned rather than derived: raising it silently would change every MAX.
  assert.equal(NATIVE_GAS_RESERVE_WEI, WAD / 100n);
});

test("MAX spends an ERC-20 whole and always leaves gas behind", () => {
  assert.equal(spendableForSwap(1_234n * WAD, false), 1_234n * WAD);
  assert.equal(spendableForSwap(0n, false), 0n);
  assert.equal(spendableForSwap(WAD, true), WAD - NATIVE_GAS_RESERVE_WEI);
  // At or below the reserve there is nothing to spend — never a negative.
  assert.equal(spendableForSwap(NATIVE_GAS_RESERVE_WEI, true), 0n);
  assert.equal(spendableForSwap(NATIVE_GAS_RESERVE_WEI / 2n, true), 0n);
  assert.equal(spendableForSwap(0n, true), 0n);
  assert.equal(spendableForSwap(NATIVE_GAS_RESERVE_WEI + 1n, true), 1n);
});

test("slippage lowers the floor and never raises it", () => {
  assert.equal(applySlippage(10_000n, 0), 10_000n);
  assert.equal(applySlippage(10_000n, 50), 9_950n);
  assert.equal(applySlippage(10_000n, 300), 9_700n);
  assert.equal(applySlippage(0n, 50), 0n);
  // Truncation is the safe direction: 3 * 9950 / 10000 = 2, not 3.
  assert.equal(applySlippage(3n, 50), 2n);
  assert.equal(applySlippage(WAD, 100), WAD * 99n / 100n);
});

test("slippage is clamped to 0…50% and rounded to whole bps", () => {
  // A negative would put the floor above the quote and revert every swap.
  assert.equal(applySlippage(10_000n, -100), 10_000n);
  assert.equal(applySlippage(10_000n, 5_000), 5_000n);
  assert.equal(applySlippage(10_000n, 9_999), 5_000n);
  assert.equal(applySlippage(10_000n, 49.6), 9_950n);
  assert.equal(applySlippage(10_000n, 0.4), 10_000n);
});

test("a staged route applies the displayed slippage only once end to end", () => {
  const quoted = 1_000_000n;
  assert.equal(endToEndMinOut(quoted, 50), 995_000n);
  assert.notEqual(endToEndMinOut(quoted, 50), applySlippage(applySlippage(quoted, 50), 50));
});

test("a quote is executable only for the amount and pair it was built for", () => {
  const quote = {
    networkId: "litvm-4441",
    rpcUrl: "https://rpc.example",
    tokenInId: "native",
    tokenOutId: "nusd",
    quotedAmountIn: 10n,
  };
  assert.equal(
    quoteMatches(quote, "litvm-4441", "https://rpc.example", "native", "nusd", 10n),
    true,
  );
  assert.equal(
    quoteMatches(quote, "litvm-4441", "https://rpc.example", "native", "nusd", 100n),
    false,
  );
  assert.equal(
    quoteMatches(quote, "litvm-4441", "https://rpc.example", "nusd", "native", 10n),
    false,
  );
  assert.equal(
    quoteMatches(quote, "other", "https://rpc.example", "native", "nusd", 10n),
    false,
  );
  assert.equal(
    quoteMatches(quote, "litvm-4441", "https://other.example", "native", "nusd", 10n),
    false,
  );
});

test("a reviewed quote stays executable only while it is young and the market has not moved", () => {
  const reviewed = { quotedAt: 1_000, amountOut: 1_000_000n };
  // Age is the hard rule, with or without a live quote.
  assert.equal(quoteFresh(reviewed, 1_000 + QUOTE_MAX_AGE_MS), true);
  assert.equal(quoteFresh(reviewed, 1_001 + QUOTE_MAX_AGE_MS), false);
  assert.equal(quoteFresh(reviewed, 999), false);
  assert.equal(quoteFresh({ quotedAt: Number.NaN, amountOut: 1n }, 1_000), false);
  // Drift beyond half the slippage (50 bps here: 0.25%), in either direction.
  const at = (amountOut: bigint) => ({ quotedAt: 2_000, amountOut });
  assert.equal(quoteFresh(reviewed, 3_000, at(1_002_500n), 50), true);
  assert.equal(quoteFresh(reviewed, 3_000, at(997_500n), 50), true);
  assert.equal(quoteFresh(reviewed, 3_000, at(1_002_501n), 50), false);
  assert.equal(quoteFresh(reviewed, 3_000, at(997_499n), 50), false);
  // A live quote no newer than the reviewed one says nothing about drift.
  assert.equal(quoteFresh(reviewed, 3_000, { quotedAt: 1_000, amountOut: 2_000_000n }, 50), true);
  assert.equal(quoteFresh(reviewed, 3_000, null, 50), true);
});

test("the native Send reserve follows the network's decimals and the quoted fee", () => {
  // 0.01 of a coin at any decimals, never raw wei.
  assert.equal(fallbackNativeReserve(18), NATIVE_GAS_RESERVE_WEI);
  assert.equal(fallbackNativeReserve(6), 10_000n);
  assert.equal(fallbackNativeReserve(2), 1n);
  assert.equal(fallbackNativeReserve(0), 1n);
  // A 6-decimal custom coin: 5 coins leave 4.99 sendable, not nothing.
  assert.equal(nativeSendMax(5_000_000n, 6, null), 4_990_000n);
  // Once quoted, only twice the fee stays: the last 0.009 zkLTC can leave.
  const fee = 302_400_000_000n;
  assert.equal(nativeSendMax(WAD * 9n / 1000n, 18, fee), WAD * 9n / 1000n - 2n * fee);
  assert.equal(nativeSendMax(fee, 18, fee), 0n);
  assert.equal(nativeSendMax(0n, 18, null), 0n);
});
