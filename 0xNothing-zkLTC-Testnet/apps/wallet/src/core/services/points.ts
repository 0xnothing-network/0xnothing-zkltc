import type { Address, Hex } from "viem";
import { nusdPointsStakingAbi } from "../../abis";
import { CONTRACTS } from "../../config/contracts";
import { formatAmount } from "../lib/format";
import { activeNetwork, publicClient } from "../rpc/client";
import { ensureAllowance, type TxExecutionContext, writeCall } from "./tx";

export const POINTS_PER_XPOINT = 100n;
export const XPOINTS_DISPLAY_DIGITS = 2;

const DAY_SECONDS = 24 * 60 * 60;
const POINTS_WAD = 10n ** 18n;
const POINT_CREDITS_PER_XPOINT_WAD = POINTS_PER_XPOINT * POINTS_WAD;
const POSITION_READ_LIMIT = 50n;

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
  pointCredits: bigint;
  unlockTime: bigint;
  lockDuration: number;
  withdrawn: boolean;
}

export interface PointsState {
  totalLocked: bigint;
  earnedPointCredits: bigint;
  spentPointCredits: bigint;
  availablePointCredits: bigint;
  positionCount: bigint;
  positionsTruncated: boolean;
  positions: PointsPosition[];
  stakingPaused: boolean;
  redemptionEnabled: boolean;
  redemptionsPaused: boolean;
  nusdPerXPointWad: bigint;
  redemptionReserve: bigint;
  solvent: boolean;
  redemptionVisible: boolean;
}

export interface PointsRedemptionState {
  redemptionEnabled: boolean;
  redemptionsPaused: boolean;
  nusdPerXPointWad: bigint;
  redemptionReserve: bigint;
  solvent: boolean;
}

export function pointCreditsToXPoints(pointCredits: bigint): bigint {
  return pointCredits > 0n ? pointCredits / POINTS_PER_XPOINT : 0n;
}

/** The only public points unit: round 18-decimal xPoints half-up to 0.01. */
export function formatXPoints(xPointsWad: bigint): string {
  const quantum = 10n ** BigInt(18 - XPOINTS_DISPLAY_DIGITS);
  const rounded = xPointsWad > 0n
    ? ((xPointsWad + quantum / 2n) / quantum) * quantum
    : 0n;
  return `${formatAmount(rounded, 18, XPOINTS_DISPLAY_DIGITS)}xPoints`;
}

/** Convert contract accounting credits before presenting them to the user. */
export function formatPointCredits(pointCredits: bigint): string {
  return formatXPoints(pointCreditsToXPoints(pointCredits));
}

export function xPointsToPointCredits(xPointsWad: bigint): bigint {
  return xPointsWad > 0n ? xPointsWad * POINTS_PER_XPOINT : 0n;
}

export function quotePointsRedemption(
  pointCredits: bigint,
  nusdPerXPointWad: bigint,
): bigint {
  if (pointCredits <= 0n || nusdPerXPointWad <= 0n) return 0n;
  return (pointCredits * nusdPerXPointWad) / POINT_CREDITS_PER_XPOINT_WAD;
}

export function isPointsRedemptionVisible(state: PointsRedemptionState): boolean {
  return state.redemptionEnabled
    && !state.redemptionsPaused
    && state.nusdPerXPointWad > 0n
    && state.redemptionReserve > 0n
    && state.solvent;
}

function numericResult(
  calls: readonly { status: string; result?: unknown }[],
  index: number,
): bigint {
  const call = calls[index];
  return call?.status === "success" && typeof call.result === "bigint" ? call.result : 0n;
}

function booleanResult(
  calls: readonly { status: string; result?: unknown }[],
  index: number,
  fallback: boolean,
): boolean {
  const call = calls[index];
  return call?.status === "success" && typeof call.result === "boolean"
    ? call.result
    : fallback;
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
  const amount = tuple?.[1] ?? named.amount;
  const pointCredits = tuple?.[2] ?? named.pointCredits;
  const unlockTime = tuple?.[3] ?? named.unlockTime;
  const rawLockDuration = tuple?.[4] ?? named.lockDuration;
  const withdrawn = tuple?.[5] ?? named.withdrawn;

  if (
    typeof account !== "string"
    || account.toLowerCase() !== expectedAccount.toLowerCase()
    || typeof amount !== "bigint"
    || typeof pointCredits !== "bigint"
    || typeof unlockTime !== "bigint"
    || (typeof rawLockDuration !== "number" && typeof rawLockDuration !== "bigint")
    || typeof withdrawn !== "boolean"
  ) return undefined;

  const lockDuration = Number(rawLockDuration);
  if (!Number.isSafeInteger(lockDuration) || lockDuration < 0) return undefined;

  return {
    id,
    account: account as Address,
    amount,
    pointCredits,
    unlockTime,
    lockDuration,
    withdrawn,
  };
}

/**
 * Loads the user's on-chain points state and at most the 50 newest positions.
 * Unreadable action switches fail closed; partial position reads are omitted.
 */
export async function loadPointsState(account: Address): Promise<PointsState> {
  const client = publicClient;
  const staking = { address: CONTRACTS.nusdPointsStaking, abi: nusdPointsStakingAbi } as const;
  const calls = await client.multicall({
    allowFailure: true,
    contracts: [
      { ...staking, functionName: "totalLockedByUser", args: [account] },
      { ...staking, functionName: "earnedPointCredits", args: [account] },
      { ...staking, functionName: "spentPointCredits", args: [account] },
      { ...staking, functionName: "availablePointCredits", args: [account] },
      { ...staking, functionName: "userPositionCount", args: [account] },
      { ...staking, functionName: "stakingPaused" },
      { ...staking, functionName: "redemptionEnabled" },
      { ...staking, functionName: "redemptionsPaused" },
      { ...staking, functionName: "nusdPerXPointWad" },
      { ...staking, functionName: "redemptionReserve" },
      { ...staking, functionName: "isSolvent" },
    ] as const,
  });

  const positionCount = numericResult(calls, 4);
  const offset = positionCount > POSITION_READ_LIMIT ? positionCount - POSITION_READ_LIMIT : 0n;
  const positionIds = positionCount > 0n
    ? await client.readContract({
        ...staking,
        functionName: "userPositionIds",
        args: [account, offset, POSITION_READ_LIMIT],
      }).catch(() => [] as bigint[])
    : [];
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

  const state: PointsState = {
    totalLocked: numericResult(calls, 0),
    earnedPointCredits: numericResult(calls, 1),
    spentPointCredits: numericResult(calls, 2),
    availablePointCredits: numericResult(calls, 3),
    positionCount,
    positionsTruncated: positionCount > POSITION_READ_LIMIT,
    positions,
    // Fail closed: an unreadable flag must never enable a user action.
    stakingPaused: booleanResult(calls, 5, true),
    redemptionEnabled: booleanResult(calls, 6, false),
    redemptionsPaused: booleanResult(calls, 7, true),
    nusdPerXPointWad: numericResult(calls, 8),
    redemptionReserve: numericResult(calls, 9),
    solvent: booleanResult(calls, 10, false),
    redemptionVisible: false,
  };
  state.redemptionVisible = isPointsRedemptionVisible(state);
  return state;
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
    spender: CONTRACTS.nusdPointsStaking,
    amount: params.amount,
    symbol: "NUSD",
  }, context);
  return writeCall({
    from: params.from,
    address: CONTRACTS.nusdPointsStaking,
    abi: nusdPointsStakingAbi,
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
    address: CONTRACTS.nusdPointsStaking,
    abi: nusdPointsStakingAbi,
    functionName: "withdraw",
    args: [params.positionId],
    kind: "points-withdraw",
    label: {
      key: "tx.pointsWithdraw",
      params: { position: params.positionId.toString() },
    },
  }, context);
}

export async function redeemXPoints(params: {
  from: Address;
  pointCredits: bigint;
}): Promise<Hex> {
  const context = { network: activeNetwork, client: publicClient } satisfies TxExecutionContext;
  return writeCall({
    from: params.from,
    address: CONTRACTS.nusdPointsStaking,
    abi: nusdPointsStakingAbi,
    functionName: "redeemPoints",
    args: [params.pointCredits],
    kind: "points-redeem",
    label: {
      key: "tx.pointsRedeem",
      params: { amount: formatPointCredits(params.pointCredits) },
    },
  }, context);
}
