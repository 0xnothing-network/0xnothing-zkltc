import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { rewardStakingAbi } from "../../src/abis/index.ts";
import { formatAmount } from "../../src/core/lib/format.ts";
import { evaluateModule } from "../../../web/tests/helpers/evaluateModule.ts";

interface PointsModule {
  POINTS_LOCK_OPTIONS: readonly { duration: number; multiplierBps: number }[];
  POINT_SECONDS_PER_DISPLAY_POINT: bigint;
  POINTS_DISPLAY_DIGITS: number;
  formatPoints(points: bigint): string;
  formatPointsPerDay(weight: bigint): string;
  rewardShareBps(weight: bigint, totalWeight: bigint): number;
  dailyReward(rewardRate: bigint, weight: bigint, totalWeight: bigint): bigint;
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
  rewardShareBps,
  dailyReward,
  stakeWeight,
};`, sandbox);
const {
  POINTS_LOCK_OPTIONS,
  POINT_SECONDS_PER_DISPLAY_POINT,
  POINTS_DISPLAY_DIGITS,
  formatPoints,
  formatPointsPerDay,
  rewardShareBps,
  dailyReward,
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
    "rewardRate",
    "totalWeight",
    "queuedRewards",
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

test("stake weight, stream share and daily reward use integer contract units", () => {
  assert.equal(stakeWeight(100n * WAD, 30_000), 300n * WAD);
  assert.equal(stakeWeight(100n * WAD, 12_000), 120n * WAD);
  assert.equal(stakeWeight(0n, 30_000), 0n);
  assert.equal(rewardShareBps(1n, 4n), 2_500);
  assert.equal(rewardShareBps(5n, 0n), 0);
  assert.equal(rewardShareBps(0n, 10n), 0);
  // 70 NUSD streamed over 7 days, a quarter of the weight: 2.5 NUSD a day.
  const rate = 70n * WAD / (7n * DAY);
  assert.equal(dailyReward(rate, 1n * WAD, 4n * WAD), rate * DAY / 4n);
  assert.equal(dailyReward(0n, WAD, WAD), 0n);
  assert.equal(dailyReward(rate, WAD, 0n), 0n);
});

test("position reads stay bounded: the newest 50 first, pages of 50, never more than 500", () => {
  assert.match(source, /export const POSITION_PAGE = 50;/u);
  assert.match(source, /export const POSITION_READ_CAP = 500;/u);
  assert.match(source, /const readLimit = positionReadLimit\(limit\);/u);
  assert.match(source, /allIds\.slice\(-readLimit\)/u);
  assert.match(source, /positionsTruncated: allIds\.length > readLimit/u);
});

function pointsWithPositions(count: number) {
  const owner = `0x${"11".repeat(20)}`;
  const ids = Array.from({ length: count }, (_, index) => BigInt(index + 1));
  const reads: number[] = [];
  const module = evaluateModule<{
    loadPointsState(account: string, limit?: number): Promise<{
      positions: Array<{ id: bigint }>;
      positionsRead: number;
      positionsTruncated: boolean;
      positionCount: bigint;
      totalLocked: bigint;
    }>;
    positionReadLimit(requested: number): number;
  }>(new URL("../../src/core/services/points.ts", import.meta.url), {
    "../../abis": { rewardStakingAbi: [] },
    "../../config/contracts": { CONTRACTS: { rewardStaking: `0x${"22".repeat(20)}` } },
    "../lib/format": { formatAmount },
    "../rpc/client": {
      activeNetwork: {},
      publicClient: {
        multicall: async ({ contracts }: { contracts: Array<{ functionName: string; args?: unknown[] }> }) => {
          if (contracts[0]?.functionName === "accountState") {
            return [
              { status: "success", result: [0n, 0n, 0n] },
              { status: "success", result: ids },
              { status: "success", result: 0n },
              { status: "success", result: 0n },
              { status: "success", result: 0n },
            ];
          }
          reads.push(contracts.length);
          return contracts.map(({ args }) => ({
            status: "success",
            result: [owner, 0n, 0, (args![0] as bigint) % 2n === 0n, 1n, 1n],
          }));
        },
      },
    },
    "./tx": {},
  });
  return { module, owner, reads };
}

test("older positions load page by page, newest first, up to the cap", async () => {
  const { module, owner, reads } = pointsWithPositions(612);
  const first = await module.loadPointsState(owner);
  assert.equal(first.positions.length, 50);
  assert.equal(first.positions[0]!.id, 612n, "newest first");
  assert.equal(first.positions.at(-1)!.id, 563n);
  assert.equal(first.positionsRead, 50);
  assert.equal(first.positionsTruncated, true);
  assert.equal(first.positionCount, 612n);
  const second = await module.loadPointsState(owner, 100);
  assert.equal(second.positions.at(-1)!.id, 513n, "the next 50 older ones are on screen and can be withdrawn");
  assert.equal(second.totalLocked, 50n, "only the positions not withdrawn count");
  const capped = await module.loadPointsState(owner, 10_000);
  assert.equal(capped.positionsRead, 500);
  assert.equal(capped.positionsTruncated, true);
  assert.deepEqual(reads, [50, 100, 500]);
  for (const [requested, expected] of [[0, 50], [-5, 50], [Number.NaN, 50], [1.5, 50], [150, 150], [501, 500]] as const) {
    assert.equal(module.positionReadLimit(requested), expected, String(requested));
  }
  const small = pointsWithPositions(30);
  const all = await small.module.loadPointsState(small.owner, 100);
  assert.equal(all.positionsRead, 30);
  assert.equal(all.positionsTruncated, false);
});

test("Earn pages back from the same read and resets the page for another account or network", () => {
  const earn = readFileSync(new URL("../../src/ui/screens/Earn.tsx", import.meta.url), "utf8");
  assert.match(earn, /const pageKey = `\$\{address \?\? ""\}:\$\{network\.id\}`;/u);
  assert.match(earn, /const positionLimit = paging\.key === pageKey \? paging\.limit : POSITION_PAGE;/u);
  assert.match(earn, /loadPointsState\(address, positionLimit\)/u);
  assert.match(earn, /state\?\.positionsTruncated === true && positionLimit < POSITION_READ_CAP/u);
  assert.match(earn, /limit: Math\.min\(positionLimit \+ POSITION_PAGE, POSITION_READ_CAP\)/u);
  // The page size is not part of the read's identity: loading older keeps the list on screen.
  // Paged back, no block-by-block re-read of up to 500 positions.
  assert.ok(earn.includes("{ identity: [address, network.id, network.rpcUrl, tokens], live: positionLimit === POSITION_PAGE }"));
});

test("Load older is busy until the read has caught up with the page asked for", () => {
  const earn = readFileSync(new URL("../../src/ui/screens/Earn.tsx", import.meta.url), "utf8");
  // read.loading stays false while the previous page is shown, so it cannot gate the button.
  assert.ok(earn.includes("const pagePending = state !== null && state.positionsRead < Math.min(positionLimit, Number(state.positionCount));"));
  assert.match(earn, /disabled=\{pagePending\}\n\s+aria-busy=\{pagePending\}/u);
  assert.ok(earn.includes(`{pagePending ? t("common.working") : t("earn.loadOlder")}`));
  const pagePending = (read: number, limit: number, count: number) => read < Math.min(limit, count);
  assert.equal(pagePending(50, 100, 120), true, "the second page was asked for and not read yet");
  assert.equal(pagePending(100, 100, 120), false);
  assert.equal(pagePending(70, 100, 70), false, "fewer positions than the limit");
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
