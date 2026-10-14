/**
 * Lending risk maths for the Silver Standard HF UI (ui-redesign-spec §6.5).
 *
 *   LTV = debt / collateralValue
 *   HF  = liquidationThreshold / LTV  (= collateralValue * threshold / debt)
 *   Liquidation price per collateral unit = debt / (collateralAmount * threshold)
 *
 * Thresholds are basis points read from pool config, never hard-coded here.
 * Values are plain numbers: this is display maths, not settlement maths.
 */

export const BPS = 10_000;

export type HealthBand = "none" | "safe" | "caution" | "risk" | "danger" | "liquidatable";

export const HEALTH_BAND_LABEL: Record<HealthBand, string> = {
  none: "No debt",
  safe: "Safe",
  caution: "Caution",
  risk: "Risk",
  danger: "Danger",
  liquidatable: "Liquidatable",
};

/** Health factor, or null when there is no debt. Zero collateral with debt gives 0. */
export function healthFactor(collateralValue: number, debt: number, liquidationThresholdBps: number): number | null {
  if (!(debt > 0)) return null;
  if (!(collateralValue > 0) || !(liquidationThresholdBps > 0)) return 0;
  return (collateralValue * (liquidationThresholdBps / BPS)) / debt;
}

/** Same as healthFactor but from an LTV in bps (HF = threshold / LTV). */
export function healthFactorFromLtv(ltvBps: number, liquidationThresholdBps: number): number | null {
  if (!(ltvBps > 0)) return null;
  if (!(liquidationThresholdBps > 0)) return 0;
  return liquidationThresholdBps / ltvBps;
}

/** Collateral price at which the position becomes liquidatable, or null without debt/collateral. */
export function liquidationPrice(debt: number, collateralAmount: number, liquidationThresholdBps: number): number | null {
  if (!(debt > 0) || !(collateralAmount > 0) || !(liquidationThresholdBps > 0)) return null;
  return debt / (collateralAmount * (liquidationThresholdBps / BPS));
}

/**
 * Additional debt that can be taken while keeping HF >= target (default 1.5),
 * also capped by max LTV. Never negative.
 */
export function safeMaxBorrow(
  collateralValue: number,
  debt: number,
  liquidationThresholdBps: number,
  maxLtvBps: number,
  targetHealthFactor = 1.5,
): number {
  if (!(collateralValue > 0) || !(targetHealthFactor > 0)) return 0;
  const byHealth = (collateralValue * (liquidationThresholdBps / BPS)) / targetHealthFactor;
  const byLtv = collateralValue * (maxLtvBps / BPS);
  const limit = Math.min(byHealth, byLtv);
  return Math.max(0, limit - Math.max(0, debt));
}

/** Percentage drop in collateral price that triggers liquidation (0..1), or null without debt. */
export function dropToLiquidation(hf: number | null): number | null {
  if (hf === null || !Number.isFinite(hf)) return null;
  if (hf <= 1) return 0;
  return 1 - 1 / hf;
}

/** HF bands: ≥2 safe · 1.5–2 caution · 1.25–1.5 risk · 1–1.25 danger · <1 liquidatable. */
export function healthBand(hf: number | null): HealthBand {
  if (hf === null) return "none";
  if (hf < 1) return "liquidatable";
  if (hf < 1.25) return "danger";
  if (hf < 1.5) return "risk";
  if (hf < 2) return "caution";
  return "safe";
}

/**
 * HF from the pool's aggregated `accountRisk` values (both 18-decimal NUSD):
 * liquidationCapacity already applies each collateral's on-chain liquidation
 * threshold, so HF = liquidationCapacity / debt. Null without debt.
 */
export function healthFactorFromCapacity(liquidationCapacityWei: bigint | undefined, debtWei: bigint | undefined): number | null {
  if (debtWei === undefined || debtWei <= 0n || liquidationCapacityWei === undefined) return null;
  // Scale in bigint first so large wad values keep 4 decimals of precision.
  return Number((liquidationCapacityWei * 10_000n) / debtWei) / 10_000;
}

/**
 * Extra NUSD that keeps HF ≥ target, also capped by the pool's own maxBorrow.
 * target is expressed in basis points of HF (15_000n = 1.5).
 */
export function safeBorrowFromCapacity(
  liquidationCapacityWei: bigint | undefined,
  debtWei: bigint | undefined,
  maxBorrowWei: bigint | undefined,
  targetHealthBps = 15_000n,
): bigint | undefined {
  if (liquidationCapacityWei === undefined || debtWei === undefined || maxBorrowWei === undefined || targetHealthBps <= 0n) return undefined;
  const byHealth = (liquidationCapacityWei * 10_000n) / targetHealthBps;
  const headroom = byHealth > debtWei ? byHealth - debtWei : 0n;
  return headroom < maxBorrowWei ? headroom : maxBorrowWei;
}
