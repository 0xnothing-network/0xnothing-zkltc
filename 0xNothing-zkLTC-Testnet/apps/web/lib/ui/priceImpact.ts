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
