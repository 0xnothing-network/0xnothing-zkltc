export const DEFAULT_DIA_ADAPTER = "0x6d18728bCB57c3Ce7DFb5A522fF22836280D6C98";
export const DEFAULT_LEAD_SECONDS = 300;
export const DEFAULT_INTERVAL_SECONDS = 60;

export const syncPriceAbi = [
  "function isFresh() view returns (bool)",
  "function syncPrice() returns (uint256 priceWad)",
  "function readPriceWad() view returns (uint256 priceWad,uint256 updatedAt,uint80 roundId)",
  "function anchorPriceWad() view returns (uint256)",
  "function anchorUpdatedAt() view returns (uint256)",
  "function maxPriceAge() view returns (uint256)",
];

export function parseBoundedInteger(value, { name, defaultValue, min, max }) {
  const candidate = String(value ?? "").trim() || String(defaultValue);
  if (!/^[0-9]+$/.test(candidate)) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  const parsed = Number(candidate);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return parsed;
}

export function parseCliMode(argv) {
  const once = argv.includes("--once");
  const dryRun = argv.includes("--dry-run");
  if (once && dryRun) throw new Error("Choose --once or --dry-run, not both");
  if (argv.some((argument) => argument.startsWith("--") && !["--once", "--dry-run"].includes(argument))) {
    throw new Error("Usage: npm run sync-price:check, npm run sync-price:once, or npm run sync-price");
  }
  return { once, dryRun, loop: !once && !dryRun };
}

export function decideSyncPrice({
  canReadPrice,
  anchorPriceWad,
  anchorUpdatedAt,
  maxPriceAge,
  now,
  leadSeconds = DEFAULT_LEAD_SECONDS,
}) {
  if (!canReadPrice) {
    return { action: "skip", reason: "feed-unreadable" };
  }
  const anchor = BigInt(anchorPriceWad ?? 0);
  if (anchor === 0n) {
    return { action: "sync", reason: "unarmed-anchor" };
  }
  const age = Math.max(0, Number(now) - Number(anchorUpdatedAt));
  const maxAge = Number(maxPriceAge);
  const lead = Number(leadSeconds);
  const refreshAge = maxAge > lead ? maxAge - lead : 0;
  if (age >= refreshAge) {
    return { action: "sync", reason: "aging-anchor" };
  }
  return { action: "skip", reason: "anchor-fresh" };
}

export function resolveAdapterAddress(value, fallback = DEFAULT_DIA_ADAPTER) {
  const candidate = String(value || fallback).trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(candidate)) {
    throw new Error("SYNC_PRICE_ADAPTER must be a 20-byte EVM address");
  }
  return candidate;
}
