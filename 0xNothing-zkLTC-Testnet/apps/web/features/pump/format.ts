import { formatUnits } from "viem";

export function formatWad(value: string | bigint, maximumFractionDigits = 2): string {
  try {
    return formatCompactNumber(Number(formatUnits(BigInt(value), 18)), maximumFractionDigits);
  } catch {
    return "0";
  }
}

export function formatDecimal(value: string, maximumFractionDigits = 8): string {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return "0";
  if (numeric > 0 && numeric < 0.000001) return numeric.toExponential(3);
  return formatCompactNumber(numeric, maximumFractionDigits);
}

export function formatCompactNumber(value: number, maximumFractionDigits = 2): string {
  if (!Number.isFinite(value)) return "0";
  return new Intl.NumberFormat("en-US", {
    notation: Math.abs(value) >= 1_000 ? "compact" : "standard",
    maximumFractionDigits,
  }).format(value);
}

export function formatTokenAmount(value: bigint, maximumFractionDigits = 6): string {
  const [wholeRaw, fractionRaw = ""] = formatUnits(value, 18).split(".");
  const whole = wholeRaw.replace(/^0+(?=\d)/, "") || "0";
  const fraction = fractionRaw.slice(0, maximumFractionDigits).replace(/0+$/, "");

  if (whole.length <= 3) return fraction ? `${whole}.${fraction}` : whole;

  const suffixes = ["", "K", "M", "B", "T", "Q"];
  const group = Math.floor((whole.length - 1) / 3);
  const leadingLength = whole.length - group * 3;
  const leading = whole.slice(0, leadingLength);
  const decimals = whole.slice(leadingLength, leadingLength + 2).replace(/0+$/, "");
  const compact = decimals ? `${leading}.${decimals}` : leading;
  return group < suffixes.length
    ? `${compact}${suffixes[group]}`
    : `${compact}e${whole.length - 1}`;
}

export function formatSupplyPercentage(
  balance: string | bigint,
  totalSupply: string | bigint,
  fractionDigits = 4,
): string {
  try {
    const value = BigInt(balance);
    const total = BigInt(totalSupply);
    if (value <= 0n || total <= 0n) return "0%";

    const safeDigits = Math.min(Math.max(Math.trunc(fractionDigits), 0), 8);
    const scale = 10n ** BigInt(safeDigits);
    const scaledPercent = (value * 100n * scale + total / 2n) / total;
    if (scaledPercent === 0n) return `<${safeDigits ? `0.${"0".repeat(safeDigits - 1)}1` : "1"}%`;

    const whole = scaledPercent / scale;
    const fraction = (scaledPercent % scale).toString().padStart(safeDigits, "0").replace(/0+$/, "");
    return `${whole}${fraction ? `.${fraction}` : ""}%`;
  } catch {
    return "0%";
  }
}

export function formatRelativeTime(timestamp: number): string {
  if (!timestamp) return "No activity";
  const seconds = Math.max(0, Math.floor(Date.now() / 1000) - timestamp);
  if (seconds < 60) return "Just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`;
  if (seconds < 2_592_000) return `${Math.floor(seconds / 86_400)}d ago`;
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(
    new Date(timestamp * 1000),
  );
}

export function shortAddress(value: string, head = 5, tail = 4): string {
  if (value.length <= head + tail + 2) return value;
  return `${value.slice(0, head)}...${value.slice(-tail)}`;
}
