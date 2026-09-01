import assert from "node:assert/strict";
import test from "node:test";
import {
  POINTS_PER_XPOINT,
  POINTS_WAD,
  isPublicPointsRedemptionAvailable,
  pointCreditsFromXPoints,
  quotePointsRedemption,
} from "../../features/fi/lib/points.ts";

const availableRedemption = {
  enabled: true,
  paused: false,
  nusdPerXPointWad: 2n * POINTS_WAD,
  reserve: 1_000n * POINTS_WAD,
  solvent: true,
} as const;

test("xPoint input converts to 18-decimal point credits", () => {
  assert.equal(pointCreditsFromXPoints(POINTS_WAD), POINTS_PER_XPOINT * POINTS_WAD);
  assert.equal(pointCreditsFromXPoints(POINTS_WAD / 4n), 25n * POINTS_WAD);
  assert.equal(pointCreditsFromXPoints(0n), 0n);
});

test("redemption quote matches the contract's integer formula", () => {
  const oneXPointCredits = pointCreditsFromXPoints(POINTS_WAD);
  const quarterXPointCredits = pointCreditsFromXPoints(POINTS_WAD / 4n);

  assert.equal(quotePointsRedemption(oneXPointCredits, 2n * POINTS_WAD), 2n * POINTS_WAD);
  assert.equal(quotePointsRedemption(quarterXPointCredits, 2n * POINTS_WAD), POINTS_WAD / 2n);
  assert.equal(quotePointsRedemption(oneXPointCredits, 0n), 0n);
});

test("public redemption is hidden unless every on-chain gate is ready", () => {
  assert.equal(isPublicPointsRedemptionAvailable(availableRedemption), true);

  for (const unavailable of [
    { ...availableRedemption, enabled: false },
    { ...availableRedemption, paused: true },
    { ...availableRedemption, nusdPerXPointWad: 0n },
    { ...availableRedemption, reserve: 0n },
    { ...availableRedemption, solvent: false },
    { ...availableRedemption, enabled: undefined },
    { ...availableRedemption, paused: undefined },
    { ...availableRedemption, nusdPerXPointWad: undefined },
    { ...availableRedemption, reserve: undefined },
    { ...availableRedemption, solvent: undefined },
  ]) {
    assert.equal(isPublicPointsRedemptionAvailable(unavailable), false);
  }
});
