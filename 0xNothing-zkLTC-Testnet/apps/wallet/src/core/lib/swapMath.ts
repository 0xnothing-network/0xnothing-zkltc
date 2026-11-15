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
 * What a native Send holds back before its fee is quoted: a hundredth of one
 * coin at the network's own decimals. `NATIVE_GAS_RESERVE_WEI` is raw wei, so
 * on a custom chain with a 6-decimal coin it would hold back 10,000 coins.
 * Swap and Mint keep the fixed reserve: their second stage and approvals need gas.
 */
export function fallbackNativeReserve(decimals: number): bigint {
  return 10n ** BigInt(Math.max(0, Math.trunc(decimals) - 2));
}

/**
 * Native MAX for a Send. Once the fee is quoted only twice that fee stays
 * behind (a LiteForge send costs about 3e-7 zkLTC, so 0.01 kept the last cent
 * of an account unsendable); before the quote, the fallback reserve. Never
 * negative.
 */
export function nativeSendMax(balance: bigint, decimals: number, feeWei: bigint | null): bigint {
  const keep = feeWei !== null && feeWei > 0n ? 2n * feeWei : fallbackNativeReserve(decimals);
  return balance > keep ? balance - keep : 0n;
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
  networkId: string;
  rpcUrl: string;
  tokenInId: string;
  tokenOutId: string;
  quotedAmountIn: bigint;
}

/** Prevents a quote produced for an older form state from being submitted. */
export function quoteMatches(
  quote: QuoteIdentity,
  networkId: string,
  rpcUrl: string,
  tokenInId: string,
  tokenOutId: string,
  amountIn: bigint,
): boolean {
  return quote.networkId === networkId
    && quote.rpcUrl === rpcUrl
    && quote.tokenInId === tokenInId
    && quote.tokenOutId === tokenOutId
    && quote.quotedAmountIn === amountIn;
}

/** How long a reviewed quote may be confirmed for. */
export const QUOTE_MAX_AGE_MS = 30_000;

/**
 * Whether a reviewed quote may still be executed. Its floor is derived from the
 * quoted output, so a quote that sat on the review screen while the pool moved
 * in the user's favour leaves that move, plus the slippage, to whoever trades
 * first. Age is the hard rule. Drift counts only against a quote for the same
 * inputs taken after the reviewed one, and fails once the two outputs differ by
 * more than half the slippage, in either direction.
 */
export function quoteFresh(
  reviewed: { quotedAt: number; amountOut: bigint },
  now: number,
  live?: { quotedAt: number; amountOut: bigint } | null,
  slippageBps = 0,
): boolean {
  const age = now - reviewed.quotedAt;
  // A missing or future timestamp (a clock moved back) is not proof of freshness.
  if (!Number.isFinite(age) || age < 0 || age > QUOTE_MAX_AGE_MS) return false;
  if (!live || !(live.quotedAt > reviewed.quotedAt)) return true;
  const bps = BigInt(Math.max(0, Math.min(5_000, Math.round(slippageBps))));
  const drift = live.amountOut > reviewed.amountOut
    ? live.amountOut - reviewed.amountOut
    : reviewed.amountOut - live.amountOut;
  return drift * 20_000n <= reviewed.amountOut * bps;
}
