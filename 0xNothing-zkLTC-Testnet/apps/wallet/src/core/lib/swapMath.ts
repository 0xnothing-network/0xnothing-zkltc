/**
 * The arithmetic behind the two numbers a user can lose money on: how much of a
 * native balance MAX may spend, and how far below a quote a swap may settle.
 *
 * Kept free of every import — no viem client, no contract addresses — so both
 * are checked by `tests/swap.test.ts` without a chain, and so a screen that
 * needs the gas reserve does not pull the swap service in with it.
 */

/** A native max-in swap or send leaves this behind so the wallet can still pay gas. */
export const NATIVE_GAS_RESERVE_WEI = 10_000_000_000_000_000n;

/**
 * The spendable part of a balance. ERC-20s spend all of it; the native coin
 * keeps the reserve back, and returns zero rather than a negative when the
 * balance is at or below the reserve.
 */
export function spendableForSwap(balance: bigint, native: boolean): bigint {
  if (!native) return balance;
  return balance > NATIVE_GAS_RESERVE_WEI ? balance - NATIVE_GAS_RESERVE_WEI : 0n;
}

/**
 * The floor sent on chain as `amountOutMin`. Truncating division only ever
 * lowers the floor, which is the safe direction: a floor rounded up would
 * revert a swap that delivered exactly what was quoted.
 *
 * Slippage is clamped to 0…5000 bps (50%). A stored setting can only come from
 * the fixed list in Settings, but the clamp is what stops a corrupted value
 * from turning into an unbounded loss — or, negative, into a floor above the
 * quote.
 */
export function applySlippage(amount: bigint, slippageBps: number): bigint {
  const bps = BigInt(Math.max(0, Math.min(5_000, Math.round(slippageBps))));
  return (amount * (10_000n - bps)) / 10_000n;
}

/** One final floor for the whole route, even when execution has two stages. */
export function endToEndMinOut(quotedAmount: bigint, slippageBps: number): bigint {
  return applySlippage(quotedAmount, slippageBps);
}

export interface QuoteIdentity {
  tokenInId: string;
  tokenOutId: string;
  quotedAmountIn: bigint;
}

/** Prevents a quote produced for an older form state from being submitted. */
export function quoteMatches(
  quote: QuoteIdentity,
  tokenInId: string,
  tokenOutId: string,
  amountIn: bigint,
): boolean {
  return quote.tokenInId === tokenInId
    && quote.tokenOutId === tokenOutId
    && quote.quotedAmountIn === amountIn;
}
