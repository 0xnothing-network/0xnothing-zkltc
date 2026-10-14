import type { Address, Hex } from "viem";
import { rewardStakingAbi } from "../../abis";
import { CONTRACTS } from "../../config/contracts";
import { formatAmount } from "../lib/format";
import { activeNetwork, publicClient } from "../rpc/client";
import { ensureAllowance, type TxExecutionContext, writeCall } from "./tx";

/**
 * 0xPoints (contracts/src/rewards/RewardStaking.sol). Points are lock-weighted
 * NUSD-seconds; the wallet shows them per day, so 1 0xPoint = 1 weighted NUSD for 1 day.
 */
export const POINT_SECONDS_PER_DISPLAY_POINT = 86_400n;
export const POINTS_DISPLAY_DIGITS = 2;

const DAY_SECONDS = 24 * 60 * 60;
const POSITION_READ_LIMIT = 50;

export const POINTS_LOCK_OPTIONS = [
  { duration: 30 * DAY_SECONDS, multiplierBps: 10_000 },
  { duration: 90 * DAY_SECONDS, multiplierBps: 12_000 },
  { duration: 180 * DAY_SECONDS, multiplierBps: 15_000 },
  { duration: 365 * DAY_SECONDS, multiplierBps: 30_000 },
] as const;

export interface PointsPosition {
  id: bigint;
  account: Address;
  amount: bigint;
  /** Lock-weighted amount: 0xPoints earned per second (18 decimals). */
  weight: bigint;
  unlockTime: bigint;
  lockDuration: number;
  withdrawn: boolean;
}

export interface PointsState {
  /** Principal still locked across the loaded positions. */
  totalLocked: bigint;
  weight: bigint;
  /** The account's 0xPoints in the open round (weighted NUSD-seconds). */
  openPoints: bigint;
  /** Every 0xPoint accrued by all stakers in the open round. */
  openRoundPoints: bigint;
  claimable: bigint;
  poolAvailable: bigint;
  roundReward: bigint;
  positionCount: bigint;
  positionsTruncated: boolean;
  positions: PointsPosition[];
}

/** Weighted NUSD-seconds as displayed 0xPoints, half-up to 0.01. */
export function formatPoints(points: bigint): string {
  const display = points > 0n ? points / POINT_SECONDS_PER_DISPLAY_POINT : 0n;
  const quantum = 10n ** BigInt(18 - POINTS_DISPLAY_DIGITS);
  const rounded = ((display + quantum / 2n) / quantum) * quantum;
  return `${formatAmount(rounded, 18, POINTS_DISPLAY_DIGITS)} 0xPoints`;
}

/** A position's weight is exactly the 0xPoints it adds per day. */
export function formatPointsPerDay(weight: bigint): string {
  return `${formatAmount(weight > 0n ? weight : 0n, 18, POINTS_DISPLAY_DIGITS)} 0xPoints`;
}

/** Share of the open round in basis points; 0 when nobody has points yet. */
export function roundShareBps(points: bigint, totalPoints: bigint): number {
  if (points <= 0n || totalPoints <= 0n) return 0;
  return Number((points * 10_000n) / totalPoints);
}

export function stakeWeight(amount: bigint, multiplierBps: number): bigint {
  return amount > 0n ? (amount * BigInt(multiplierBps)) / 10_000n : 0n;
}

function numericResult(
  calls: readonly { status: string; result?: unknown }[],
  index: number,
): bigint {
  const call = calls[index];
  return call?.status === "success" && typeof call.result === "bigint" ? call.result : 0n;
}

function normalizePosition(
  id: bigint,
  value: unknown,
  expectedAccount: Address,
): PointsPosition | undefined {
  if (value === null || typeof value !== "object") return undefined;

  const tuple = Array.isArray(value) ? value : undefined;
  const named = value as Record<string, unknown>;
  const account = tuple?.[0] ?? named.account;
  const unlockTime = tuple?.[1] ?? named.unlockTime;
  const rawLockDuration = tuple?.[2] ?? named.lockDuration;
  const withdrawn = tuple?.[3] ?? named.withdrawn;
  const amount = tuple?.[4] ?? named.amount;
  const weight = tuple?.[5] ?? named.weight;

  if (
    typeof account !== "string"
    || account.toLowerCase() !== expectedAccount.toLowerCase()
    || typeof amount !== "bigint"
    || typeof weight !== "bigint"
    || typeof unlockTime !== "bigint"
    || (typeof rawLockDuration !== "number" && typeof rawLockDuration !== "bigint")
    || typeof withdrawn !== "boolean"
  ) return undefined;

  const lockDuration = Number(rawLockDuration);
  if (!Number.isSafeInteger(lockDuration) || lockDuration < 0) return undefined;

  return { id, account: account as Address, amount, weight, unlockTime, lockDuration, withdrawn };
}

/**
 * Loads the account's 0xPoints, claimable rewards, the pool and at most the 50
 * newest positions. Partial reads degrade to zero; no action depends on a guess.
 */
export async function loadPointsState(account: Address): Promise<PointsState> {
  const client = publicClient;
  const staking = { address: CONTRACTS.rewardStaking, abi: rewardStakingAbi } as const;
  const calls = await client.multicall({
    allowFailure: true,
    contracts: [
      { ...staking, functionName: "accountState", args: [account] },
      { ...staking, functionName: "positionIdsOf", args: [account] },
      { ...staking, functionName: "availableRewards" },
      { ...staking, functionName: "ROUND_REWARD" },
      { ...staking, functionName: "openRoundPoints" },
    ] as const,
  });

  const accountRead = calls[0];
  const [weight, openPoints, claimable] = accountRead?.status === "success"
    ? accountRead.result as readonly [bigint, bigint, bigint]
    : [0n, 0n, 0n];
  const idsRead = calls[1];
  const allIds = idsRead?.status === "success" ? idsRead.result as readonly bigint[] : [];
  const positionIds = allIds.slice(-POSITION_READ_LIMIT);
  const positionReads = positionIds.length > 0
    ? await client.multicall({
        allowFailure: true,
        contracts: positionIds.map((positionId) => ({
          ...staking,
          functionName: "getPosition" as const,
          args: [positionId] as const,
        })),
      }).catch(() => [])
    : [];
  const positions = positionReads.flatMap((read, index) => {
    if (read.status !== "success") return [];
    const id = positionIds[index];
    if (id === undefined) return [];
    const position = normalizePosition(id, read.result, account);
    return position ? [position] : [];
  }).reverse();

  return {
    totalLocked: positions.reduce((sum, position) => (position.withdrawn ? sum : sum + position.amount), 0n),
    weight,
    openPoints,
    openRoundPoints: numericResult(calls, 4),
    claimable,
    poolAvailable: numericResult(calls, 2),
    roundReward: numericResult(calls, 3),
    positionCount: BigInt(allIds.length),
    positionsTruncated: allIds.length > POSITION_READ_LIMIT,
    positions,
  };
}

export async function stakeNusdForPoints(params: {
  from: Address;
  amount: bigint;
  lockDuration: number;
}): Promise<Hex> {
  // Approval and stake are one action. Keep both on the same selected network.
  const context = { network: activeNetwork, client: publicClient } satisfies TxExecutionContext;
  await ensureAllowance({
    from: params.from,
    token: CONTRACTS.nusd,
    spender: CONTRACTS.rewardStaking,
    amount: params.amount,
    symbol: "NUSD",
  }, context);
  return writeCall({
    from: params.from,
    address: CONTRACTS.rewardStaking,
    abi: rewardStakingAbi,
    functionName: "stake",
    args: [params.amount, params.lockDuration],
    kind: "points-stake",
    label: {
      key: "tx.pointsStake",
      params: { amount: formatAmount(params.amount, 18, 2) },
    },
  }, context);
}

export async function withdrawPointsStake(params: {
  from: Address;
  positionId: bigint;
}): Promise<Hex> {
  const context = { network: activeNetwork, client: publicClient } satisfies TxExecutionContext;
  return writeCall({
    from: params.from,
    address: CONTRACTS.rewardStaking,
    abi: rewardStakingAbi,
    functionName: "withdraw",
    args: [params.positionId],
    kind: "points-withdraw",
    label: {
      key: "tx.pointsWithdraw",
      params: { position: params.positionId.toString() },
    },
  }, context);
}

/** Claims every allocated reward to the signing account itself. */
export async function claimPointsRewards(params: {
  from: Address;
  amount: bigint;
}): Promise<Hex> {
  const context = { network: activeNetwork, client: publicClient } satisfies TxExecutionContext;
  return writeCall({
    from: params.from,
    address: CONTRACTS.rewardStaking,
    abi: rewardStakingAbi,
    functionName: "claim",
    args: [params.from],
    kind: "points-claim",
    label: {
      key: "tx.pointsClaim",
      params: { amount: formatAmount(params.amount, 18, 2) },
    },
  }, context);
}
