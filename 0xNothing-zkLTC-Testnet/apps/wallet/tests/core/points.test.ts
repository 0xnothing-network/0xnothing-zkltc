import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { rewardStakingAbi } from "../../src/abis/index.ts";
import { formatAmount } from "../../src/core/lib/format.ts";

interface PointsModule {
  POINTS_LOCK_OPTIONS: readonly { duration: number; multiplierBps: number }[];
  POINT_SECONDS_PER_DISPLAY_POINT: bigint;
  POINTS_DISPLAY_DIGITS: number;
  formatPoints(points: bigint): string;
  formatPointsPerDay(weight: bigint): string;
  roundShareBps(points: bigint, totalPoints: bigint): number;
  stakeWeight(amount: bigint, multiplierBps: number): bigint;
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
  POINT_SECONDS_PER_DISPLAY_POINT,
  POINTS_DISPLAY_DIGITS,
  formatPoints,
  formatPointsPerDay,
  roundShareBps,
  stakeWeight,
};`, sandbox);
const {
  POINTS_LOCK_OPTIONS,
  POINT_SECONDS_PER_DISPLAY_POINT,
  POINTS_DISPLAY_DIGITS,
  formatPoints,
  formatPointsPerDay,
  roundShareBps,
  stakeWeight,
} = sandbox.points!;

const WAD = 10n ** 18n;
const DAY = 86_400n;

test("lock terms mirror RewardStaking.lockMultiplierBps", () => {
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

test("the wallet ABI exposes every user operation of RewardStaking", () => {
  const functions = new Set<string>(
    rewardStakingAbi.flatMap((item) => item.type === "function" ? [item.name] : []),
  );
  for (const name of [
    "accountState",
    "positionIdsOf",
    "getPosition",
    "availableRewards",
    "ROUND_REWARD",
    "openRoundPoints",
    "stake",
    "withdraw",
    "claim",
  ]) {
    assert.equal(functions.has(name), true, `${name} missing from the RewardStaking ABI`);
  }
});

test("0xPoints are weighted NUSD-days with hundredth precision", () => {
  assert.equal(POINT_SECONDS_PER_DISPLAY_POINT, DAY);
  assert.equal(POINTS_DISPLAY_DIGITS, 2);
  assert.equal(formatPoints(0n), "0 0xPoints");
  assert.equal(formatPoints(100n * WAD * DAY), "100 0xPoints");
  assert.equal(formatPoints(1234n * WAD * DAY / 1000n), "1.23 0xPoints");
  assert.equal(formatPoints(1235n * WAD * DAY / 1000n), "1.24 0xPoints");
  assert.equal(formatPointsPerDay(3n * WAD), "3 0xPoints");
});

test("stake weight and round share use integer contract units", () => {
  assert.equal(stakeWeight(100n * WAD, 30_000), 300n * WAD);
  assert.equal(stakeWeight(100n * WAD, 12_000), 120n * WAD);
  assert.equal(stakeWeight(0n, 30_000), 0n);
  assert.equal(roundShareBps(1n, 4n), 2_500);
  assert.equal(roundShareBps(5n, 0n), 0);
  assert.equal(roundShareBps(0n, 10n), 0);
});

test("position reads stay bounded to the newest 50", () => {
  assert.match(source, /const POSITION_READ_LIMIT = 50;/u);
  assert.match(source, /allIds\.slice\(-POSITION_READ_LIMIT\)/u);
  assert.match(source, /positionsTruncated: allIds\.length > POSITION_READ_LIMIT/u);
});

test("approval and staking stay pinned to one execution context", () => {
  assert.match(
    source,
    /const context = \{ network: activeNetwork, client: publicClient \} satisfies TxExecutionContext;/u,
  );
  assert.match(
    source,
    /ensureAllowance\(\{[\s\S]*?spender: CONTRACTS\.rewardStaking[\s\S]*?\}, context\);[\s\S]*?functionName: "stake"[\s\S]*?\}, context\);/u,
  );
});

test("rewards are only ever claimed to the signing account", () => {
  assert.match(source, /functionName: "claim",\s*args: \[params\.from\],/u);
});
