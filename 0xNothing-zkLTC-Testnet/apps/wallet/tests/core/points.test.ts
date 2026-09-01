import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { nusdPointsStakingAbi } from "../../src/abis/index.ts";
import { formatAmount } from "../../src/core/lib/format.ts";

interface PointsModule {
  POINTS_LOCK_OPTIONS: readonly { duration: number; multiplierBps: number }[];
  POINTS_PER_XPOINT: bigint;
  XPOINTS_DISPLAY_DIGITS: number;
  formatPointCredits(pointCredits: bigint): string;
  formatXPoints(xPointsWad: bigint): string;
  isPointsRedemptionVisible(state: {
    redemptionEnabled: boolean;
    redemptionsPaused: boolean;
    nusdPerXPointWad: bigint;
    redemptionReserve: bigint;
    solvent: boolean;
  }): boolean;
  pointCreditsToXPoints(pointCredits: bigint): bigint;
  quotePointsRedemption(pointCredits: bigint, nusdPerXPointWad: bigint): bigint;
  xPointsToPointCredits(xPointsWad: bigint): bigint;
}

// points.ts also owns RPC actions. Compile it without resolving those imports so
// these tests execute the real pure helpers in Node's extensionless-import test
// environment rather than duplicating their formulas here.
const source = readFileSync(new URL("../../src/core/services/points.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText
  .replace(/^import .*;\r?\n/gmu, "")
  .replace(/^export /gmu, "");
const sandbox: { formatAmount: typeof formatAmount; points?: PointsModule } = { formatAmount };
runInNewContext(`${compiled}\nglobalThis.points = {
  POINTS_LOCK_OPTIONS,
  POINTS_PER_XPOINT,
  XPOINTS_DISPLAY_DIGITS,
  formatPointCredits,
  formatXPoints,
  isPointsRedemptionVisible,
  pointCreditsToXPoints,
  quotePointsRedemption,
  xPointsToPointCredits,
};`, sandbox);
const {
  POINTS_LOCK_OPTIONS,
  POINTS_PER_XPOINT,
  XPOINTS_DISPLAY_DIGITS,
  formatPointCredits,
  formatXPoints,
  isPointsRedemptionVisible,
  pointCreditsToXPoints,
  quotePointsRedemption,
  xPointsToPointCredits,
} = sandbox.points!;

const WAD = 10n ** 18n;
const ready = {
  redemptionEnabled: true,
  redemptionsPaused: false,
  nusdPerXPointWad: 2n * WAD,
  redemptionReserve: 1_000n * WAD,
  solvent: true,
} as const;

test("points lock terms mirror the deployed contract", () => {
  const lockOptions = Array.from(POINTS_LOCK_OPTIONS, (option) => ({
    duration: option.duration,
    multiplierBps: option.multiplierBps,
  }));
  assert.deepEqual(lockOptions, [
    { duration: 30 * 86_400, multiplierBps: 10_000 },
    { duration: 90 * 86_400, multiplierBps: 12_000 },
    { duration: 180 * 86_400, multiplierBps: 15_000 },
    { duration: 365 * 86_400, multiplierBps: 30_000 },
  ]);
});

test("the wallet ABI exposes every public user points operation", () => {
  const functions = new Set<string>(
    nusdPointsStakingAbi.flatMap((item) => item.type === "function" ? [item.name] : []),
  );
  for (const name of [
    "totalLockedByUser",
    "earnedPointCredits",
    "spentPointCredits",
    "availablePointCredits",
    "userPositionCount",
    "userPositionIds",
    "getPosition",
    "stakingPaused",
    "redemptionEnabled",
    "redemptionsPaused",
    "nusdPerXPointWad",
    "redemptionReserve",
    "isSolvent",
    "quoteRedemption",
    "stake",
    "withdraw",
    "redeemPoints",
  ]) {
    assert.equal(functions.has(name), true, `${name} missing from points ABI`);
  }
});

test("point credits convert to and from 18-decimal xPoints without floats", () => {
  assert.equal(POINTS_PER_XPOINT, 100n);
  assert.equal(pointCreditsToXPoints(WAD), WAD / 100n);
  assert.equal(xPointsToPointCredits(WAD), 100n * WAD);
  assert.equal(pointCreditsToXPoints(xPointsToPointCredits(WAD / 4n)), WAD / 4n);
  assert.equal(pointCreditsToXPoints(0n), 0n);
  assert.equal(xPointsToPointCredits(0n), 0n);
});

test("user-facing xPoints use one unit with hundredth precision", () => {
  assert.equal(XPOINTS_DISPLAY_DIGITS, 2);
  assert.equal(formatXPoints(0n), "0xPoints");
  assert.equal(formatXPoints(WAD / 100n), "0.01xPoints");
  assert.equal(formatXPoints(1234n * WAD / 1000n), "1.23xPoints");
  assert.equal(formatXPoints(1235n * WAD / 1000n), "1.24xPoints");
  assert.equal(formatXPoints(WAD / 200n), "0.01xPoints");
  assert.equal(formatPointCredits(123n * WAD), "1.23xPoints");
});

test("redemption quote uses the contract's integer units", () => {
  const oneXPointCredits = xPointsToPointCredits(WAD);
  assert.equal(quotePointsRedemption(oneXPointCredits, 2n * WAD), 2n * WAD);
  assert.equal(quotePointsRedemption(oneXPointCredits / 4n, 2n * WAD), WAD / 2n);
  assert.equal(quotePointsRedemption(oneXPointCredits, 0n), 0n);
});

test("redemption remains hidden unless every public on-chain gate is ready", () => {
  assert.equal(isPointsRedemptionVisible(ready), true);
  for (const blocked of [
    { ...ready, redemptionEnabled: false },
    { ...ready, redemptionsPaused: true },
    { ...ready, nusdPerXPointWad: 0n },
    { ...ready, redemptionReserve: 0n },
    { ...ready, solvent: false },
  ]) {
    assert.equal(isPointsRedemptionVisible(blocked), false);
  }
});

test("RPC position reads stay bounded and action switches fail closed", () => {
  assert.match(source, /const POSITION_READ_LIMIT = 50n;/u);
  assert.match(
    source,
    /positionCount > POSITION_READ_LIMIT \? positionCount - POSITION_READ_LIMIT : 0n/u,
  );
  assert.match(source, /stakingPaused: booleanResult\(calls, 5, true\)/u);
  assert.match(source, /redemptionEnabled: booleanResult\(calls, 6, false\)/u);
  assert.match(source, /redemptionsPaused: booleanResult\(calls, 7, true\)/u);
  assert.match(source, /solvent: booleanResult\(calls, 10, false\)/u);
});

test("approval and staking stay pinned to one execution context", () => {
  assert.match(
    source,
    /const context = \{ network: activeNetwork, client: publicClient \} satisfies TxExecutionContext;/u,
  );
  assert.match(
    source,
    /ensureAllowance\(\{[\s\S]*?spender: CONTRACTS\.nusdPointsStaking[\s\S]*?\}, context\);[\s\S]*?functionName: "stake"[\s\S]*?\}, context\);/u,
  );
});
