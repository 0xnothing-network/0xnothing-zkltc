import { formatUnits, parseUnits } from "viem";

/** 1e18, the fixed-point scale every contract in this project uses. */
export const WAD = 10n ** 18n;

export function shortenAddress(address: string, head = 6, tail = 4): string {
  if (address.length <= head + tail + 2) return address;
  return `${address.slice(0, head)}…${address.slice(-tail)}`;
}

/**
 * Groups the integer part and trims trailing zeros. Deliberately never uses
 * scientific notation: a wallet that shows "1e-7 NUSD" is unreadable.
 */
export function formatAmount(value: bigint, decimals: number, maxFractionDigits = 6): string {
  const raw = formatUnits(value, decimals);
  const [whole = "0", fraction = ""] = raw.split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/gu, ",");
  const trimmed = fraction.slice(0, maxFractionDigits).replace(/0+$/u, "");
  return trimmed.length > 0 ? `${grouped}.${trimmed}` : grouped;
}

/** Keeps small balances legible: more decimals the smaller the number. */
export function formatBalance(value: bigint, decimals: number): string {
  if (value === 0n) return "0";
  const asNumber = Number(formatUnits(value, decimals));
  if (asNumber >= 1000) return formatAmount(value, decimals, 2);
  if (asNumber >= 1) return formatAmount(value, decimals, 4);
  if (asNumber >= 0.0001) return formatAmount(value, decimals, 6);
  return formatAmount(value, decimals, 8);
}

/** USD is always shown with two decimals, the way the site's panels do. */
export function formatUsdWad(valueWad: bigint): string {
  const negative = valueWad < 0n;
  const magnitude = negative ? -valueWad : valueWad;
  const cents = (magnitude + 5n * 10n ** 15n) / 10n ** 16n;
  const whole = (cents / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/gu, ",");
  const fraction = (cents % 100n).toString().padStart(2, "0");
  return `${negative ? "-" : ""}$${whole}.${fraction}`;
}

export function formatSignedPercent(ratio: number, digits = 2): string {
  if (!Number.isFinite(ratio)) return "--";
  const sign = ratio > 0 ? "+" : ratio < 0 ? "-" : "";
  return `${sign}${Math.abs(ratio * 100).toFixed(digits)}%`;
}

/** Contract rates are WAD fractions per year. */
export function formatRateWad(rateWad: bigint, digits = 2): string {
  return `${(Number(rateWad) / Number(WAD) * 100).toFixed(digits)}%`;
}

/** Returns null instead of throwing: every caller is a text input. */
export function parseAmount(input: string, decimals: number): bigint | null {
  const cleaned = input.trim().replace(/,/gu, "");
  if (cleaned.length === 0) return null;
  if (!/^\d*(\.\d*)?$/u.test(cleaned)) return null;
  try {
    const value = parseUnits(cleaned as `${number}`, decimals);
    return value < 0n ? null : value;
  } catch {
    return null;
  }
}

export function usdValueWad(amount: bigint, decimals: number, priceWad: bigint): bigint {
  const scale = 10n ** BigInt(decimals);
  return (amount * priceWad) / scale;
}

export function formatTimeAgo(timestampMs: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.floor((now - timestampMs) / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86_400)}d`;
}

export function formatClock(timestampMs: number): string {
  const date = new Date(timestampMs);
  const pad = (part: number): string => part.toString().padStart(2, "0");
  return `${pad(date.getDate())}/${pad(date.getMonth() + 1)} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
