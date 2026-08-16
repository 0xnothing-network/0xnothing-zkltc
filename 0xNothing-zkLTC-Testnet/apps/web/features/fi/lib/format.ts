import { formatUnits, parseUnits, type Address } from "viem";

export function parseAmount(value: string, decimals = 18): bigint | undefined {
  const normalized = value.trim();
  if (!/^(?:\d+|\d*\.\d+)$/.test(normalized)) return undefined;
  try {
    const amount = parseUnits(normalized, decimals);
    return amount > 0n ? amount : undefined;
  } catch {
    return undefined;
  }
}

export function formatAmount(
  value: bigint | undefined,
  decimals = 18,
  maximumFractionDigits = 4,
): string {
  if (value === undefined) return "--";
  const formatted = Number(formatUnits(value, decimals));
  if (!Number.isFinite(formatted)) return "--";
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits,
    minimumFractionDigits: 0,
  }).format(formatted);
}

export function formatTokenAmount(value: bigint | undefined, decimals = 18): string {
  if (value === undefined) return "--";
  const formatted = Number(formatUnits(value, decimals));
  if (!Number.isFinite(formatted)) return "--";
  if (formatted === 0) return "0";
  if (Math.abs(formatted) >= 0.01) return formatAmount(value, decimals, 4);

  const firstSignificantDecimal = Math.max(0, Math.ceil(-Math.log10(Math.abs(formatted))));
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: Math.min(decimals, firstSignificantDecimal + 5),
    minimumFractionDigits: 0,
  }).format(formatted);
}

export function formatPercentWad(value: bigint | undefined): string {
  if (value === undefined) return "--";
  return `${formatAmount(value * 100n, 18, 2)}%`;
}

export function shortAddress(address: Address, head = 5, tail = 4): string {
  return `${address.slice(0, head + 2)}...${address.slice(-tail)}`;
}

export function minimumAfterSlippage(amount: bigint, slippageBps: bigint): bigint {
  return (amount * (10_000n - slippageBps)) / 10_000n;
}

export function transactionDeadline(minutes = 20): bigint {
  return BigInt(Math.floor(Date.now() / 1000) + minutes * 60);
}

export function percentageShare(balance: bigint | undefined, total: bigint | undefined): string {
  if (!balance || !total) return "0.00%";
  return `${Number((balance * 1_000_000n) / total) / 10_000}%`;
}

export function formatRelativeTimestamp(timestampSeconds: number): string {
  const delta = Math.max(0, Math.floor(Date.now() / 1000) - timestampSeconds);
  if (delta < 60) return `${delta}s ago`;
  if (delta < 3_600) return `${Math.floor(delta / 60)}m ago`;
  if (delta < 86_400) return `${Math.floor(delta / 3_600)}h ago`;
  return `${Math.floor(delta / 86_400)}d ago`;
}
