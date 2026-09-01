export const POINTS_PER_XPOINT = 100n;
export const POINTS_WAD = 10n ** 18n;
export const POINT_CREDITS_PER_XPOINT_WAD = POINTS_PER_XPOINT * POINTS_WAD;

export interface PublicPointsRedemptionState {
  enabled: boolean | undefined;
  paused: boolean | undefined;
  nusdPerXPointWad: bigint | undefined;
  reserve: bigint | undefined;
  solvent: boolean | undefined;
}

export function pointCreditsFromXPoints(xPointsWad: bigint): bigint {
  return xPointsWad > 0n ? xPointsWad * POINTS_PER_XPOINT : 0n;
}

export function quotePointsRedemption(
  pointCredits: bigint,
  nusdPerXPointWad: bigint,
): bigint {
  if (pointCredits <= 0n || nusdPerXPointWad <= 0n) return 0n;
  return (pointCredits * nusdPerXPointWad) / POINT_CREDITS_PER_XPOINT_WAD;
}

export function isPublicPointsRedemptionAvailable({
  enabled,
  paused,
  nusdPerXPointWad,
  reserve,
  solvent,
}: PublicPointsRedemptionState): boolean {
  return enabled === true
    && paused === false
    && solvent === true
    && nusdPerXPointWad !== undefined
    && nusdPerXPointWad > 0n
    && reserve !== undefined
    && reserve > 0n;
}
