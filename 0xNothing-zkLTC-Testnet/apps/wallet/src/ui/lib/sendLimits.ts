import { nativeSendMax } from "../../core/lib/swapMath";

/**
 * The amount checks of the Send screen. "Over" is the balance itself, for the
 * gas coin too: the fee is quoted for every send, so `shortOnGas` is the real
 * gas guard and no fixed reserve has to stand in for it (0.01 coin kept the
 * last cent of an account unsendable, and on a 6-decimal chain refused every
 * send). Swap and Mint keep their reserve: staged routes need later gas.
 */
export function sendLimits(input: {
  native: boolean;
  parsed: bigint | null;
  balance: bigint | null;
  nativeBalance: bigint | null;
  feeWei: bigint | null;
}): { over: boolean; shortOnGas: boolean } {
  const { native, parsed, balance, nativeBalance, feeWei } = input;
  const over = parsed !== null && balance !== null && parsed > balance;
  const shortOnGas = feeWei !== null
    && nativeBalance !== null
    && (
      native
        ? parsed !== null && parsed + feeWei > nativeBalance
        : feeWei > nativeBalance
    );
  return { over, shortOnGas };
}

/**
 * MAX on Send. A token sends its whole balance. The gas coin keeps twice the
 * quoted fee behind, or the decimals-scaled fallback before any quote; when
 * that fallback would leave nothing, the whole balance is filled so a quote
 * can run and MAX can refine on it (`refine`).
 */
export function sendMax(
  balance: bigint,
  native: boolean,
  decimals: number,
  feeWei: bigint | null,
): { amount: bigint; refine: boolean } {
  if (!native) return { amount: balance, refine: false };
  const amount = nativeSendMax(balance, decimals, feeWei);
  const quoted = feeWei !== null && feeWei > 0n;
  if (amount === 0n && !quoted) return { amount: balance, refine: balance > 0n };
  return { amount, refine: !quoted };
}
