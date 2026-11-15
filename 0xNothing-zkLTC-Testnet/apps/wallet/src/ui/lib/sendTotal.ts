import { formatAmount, formatFee } from "../../core/lib/format";

/**
 * The review's Total. A gas-coin send is one figure, amount plus fee, in eight
 * decimals so a LiteForge fee (a few 1e-7) is not rounded away. A token send
 * is two lines, the token amount and the fee in the gas coin: two assets are
 * never added together.
 */
export function sendTotalLines(input: {
  native: boolean;
  amount: bigint;
  feeWei: bigint;
  decimals: number;
  symbol: string;
  nativeDecimals: number;
  nativeSymbol: string;
}): string[] {
  if (input.native) return [`${formatAmount(input.amount + input.feeWei, input.nativeDecimals, 8)} ${input.nativeSymbol}`];
  return [
    `${formatAmount(input.amount, input.decimals, 6)} ${input.symbol}`,
    `+ ${formatFee(input.feeWei, input.nativeDecimals)} ${input.nativeSymbol}`,
  ];
}
