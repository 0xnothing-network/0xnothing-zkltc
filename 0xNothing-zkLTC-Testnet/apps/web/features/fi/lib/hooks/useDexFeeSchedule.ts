"use client";

import type { Address } from "viem";
import { useReadContracts } from "wagmi";
import { dexRouterAbi } from "@fi/lib/abis/dex";

/**
 * Router fee schedule. Pairs keep the LP fee on every hop; the router adds one protocol fee per
 * swap, paid in NUSD or zkLTC: the direct rate when either end of the path is NUSD or WzkLTC,
 * the cross rate when both ends are ordinary tokens (TOKEN -> base -> TOKEN).
 */
export interface DexFeeSchedule {
  lpFeeBps: number;
  directFeeBps: number;
  crossFeeBps: number;
}

export function useDexFeeSchedule(router: Address | undefined): DexFeeSchedule | undefined {
  const reads = useReadContracts({
    contracts: router ? [
      { address: router, abi: dexRouterAbi, functionName: "LP_FEE_BPS" },
      { address: router, abi: dexRouterAbi, functionName: "DIRECT_FEE_BPS" },
      { address: router, abi: dexRouterAbi, functionName: "CROSS_FEE_BPS" },
    ] as const : [],
    query: { enabled: Boolean(router), staleTime: Infinity, retry: false },
  });
  const lpFeeBps = reads.data?.[0]?.result as bigint | undefined;
  const directFeeBps = reads.data?.[1]?.result as bigint | undefined;
  const crossFeeBps = reads.data?.[2]?.result as bigint | undefined;
  if (lpFeeBps === undefined || directFeeBps === undefined || crossFeeBps === undefined) return undefined;
  return { lpFeeBps: Number(lpFeeBps), directFeeBps: Number(directFeeBps), crossFeeBps: Number(crossFeeBps) };
}

function isBase(token: Address, bases: readonly (Address | undefined)[]): boolean {
  return bases.some((base) => base?.toLowerCase() === token.toLowerCase());
}

/** Protocol fee for a path, mirroring the router's `routerFeeBpsForPath`. */
export function routerFeeBpsForPath(
  schedule: DexFeeSchedule,
  path: readonly Address[],
  bases: readonly (Address | undefined)[],
): number {
  const direct = isBase(path[0], bases) || isBase(path[path.length - 1], bases);
  return direct ? schedule.directFeeBps : schedule.crossFeeBps;
}

/** LP fee on every hop plus the single protocol fee. */
export function totalSwapFeeBps(
  schedule: DexFeeSchedule,
  path: readonly Address[],
  bases: readonly (Address | undefined)[],
): number {
  return (path.length - 1) * schedule.lpFeeBps + routerFeeBpsForPath(schedule, path, bases);
}

export function formatFeeBps(feeBps: number | undefined): string {
  if (feeBps === undefined) return "--";
  return `${feeBps / 100}%`;
}
