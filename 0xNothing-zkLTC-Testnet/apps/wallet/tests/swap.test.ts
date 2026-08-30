import assert from "node:assert/strict";
import { test } from "node:test";
import { WAD } from "../src/core/lib/format.ts";
import {
  applySlippage,
  endToEndMinOut,
  NATIVE_GAS_RESERVE_WEI,
  quoteMatches,
  spendableForSwap,
} from "../src/core/lib/swapMath.ts";

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
