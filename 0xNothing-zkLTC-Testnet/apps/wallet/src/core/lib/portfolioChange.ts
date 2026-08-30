/** Minimal priced holding shape used by the 24h market-weighting calculation. */
export interface WeightedHolding {
  token: { id: string; address?: string };
  valueWad: bigint;
}

/** Weighted market move; ignores balance transfers and never invents an unpriced leg. */
export function weightedPortfolioChange24h(
  rows: readonly WeightedHolding[],
  suppliedNusd: bigint,
  changes: Readonly<Record<string, number>>,
): number | null {
  const total = rows.reduce((sum, row) => sum + row.valueWad, suppliedNusd);
  if (total <= 0n) return null;
  let currentKnown = suppliedNusd;
  let previousKnown = suppliedNusd;
  for (const row of rows) {
    if (row.valueWad <= 0n) continue;
    const key = row.token.address?.toLowerCase() ?? row.token.id;
    const change = changes[key];
    if (change === undefined || !Number.isFinite(change) || change <= -1 || change > 10_000) continue;
    const bps = BigInt(Math.round(change * 10_000));
    const denominator = 10_000n + bps;
    if (denominator <= 0n) continue;
    currentKnown += row.valueWad;
    previousKnown += (row.valueWad * 10_000n) / denominator;
  }
  // Do not label a small priced fragment as the whole portfolio's movement.
  if (currentKnown * 100n < total * 60n || previousKnown <= 0n) return null;
  const deltaBps = ((currentKnown - previousKnown) * 10_000n) / previousKnown;
  return Number(deltaBps) / 10_000;
}
