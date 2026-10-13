/** Uniswap-style price impact ladder (spec §1.1 / §6.3): <1 green, 1–3 amber, 3–5 orange, ≥5 red + confirm. */
export type ImpactTone = "low" | "medium" | "high" | "severe";

export function impactTone(percent: number): ImpactTone {
  const value = Math.abs(percent);
  if (!Number.isFinite(value)) return "severe";
  if (value < 1) return "low";
  if (value < 3) return "medium";
  if (value < 5) return "high";
  return "severe";
}

export function impactNeedsConfirmation(percent: number): boolean {
  return impactTone(percent) === "severe";
}

/**
 * Price impact (percent, ≥ 0) of a bonding-curve trade versus the current spot
 * price in NUSD per token. Both amounts are 18-decimal wei. Returns null when
 * any input is missing or zero, so the UI can show "—" instead of a fake 0%.
 *   buy:  execution = NUSD in / tokens out, impact = execution / spot − 1
 *   sell: execution = NUSD out / tokens in, impact = 1 − execution / spot
 */
export function curvePriceImpact(
  side: "buy" | "sell",
  spotNusdPerToken: number,
  amountInWei: bigint,
  amountOutWei: bigint,
): number | null {
  if (!(spotNusdPerToken > 0) || amountInWei <= 0n || amountOutWei <= 0n) return null;
  const amountIn = Number(amountInWei) / 1e18;
  const amountOut = Number(amountOutWei) / 1e18;
  const execution = side === "buy" ? amountIn / amountOut : amountOut / amountIn;
  const impact = side === "buy" ? execution / spotNusdPerToken - 1 : 1 - execution / spotNusdPerToken;
  return Math.max(0, impact * 100);
}
