"use client";

import type { Address } from "viem";
import { useReadContracts } from "wagmi";
import { dexRouterAbi } from "@fi/lib/abis/dex";

export interface DexFeeSchedule {
  lpFeeBps: number;
  protocolFeeBps: number;
  routeSurchargeBps: number;
}

export function useDexFeeSchedule(router: Address | undefined): DexFeeSchedule | undefined {
  const reads = useReadContracts({
    contracts: router ? [
      { address: router, abi: dexRouterAbi, functionName: "LP_FEE_BPS" },
      { address: router, abi: dexRouterAbi, functionName: "PROTOCOL_FEE_BPS" },
      { address: router, abi: dexRouterAbi, functionName: "ROUTE_SURCHARGE_BPS" },
    ] as const : [],
    query: { enabled: Boolean(router), staleTime: Infinity, retry: false },
  });
  const lpFeeBps = reads.data?.[0]?.result as bigint | undefined;
  const protocolFeeBps = reads.data?.[1]?.result as bigint | undefined;
  const routeSurchargeBps = reads.data?.[2]?.result as bigint | undefined;
  if (lpFeeBps === undefined || protocolFeeBps === undefined || routeSurchargeBps === undefined) {
    return undefined;
  }
  return {
    lpFeeBps: Number(lpFeeBps),
    protocolFeeBps: Number(protocolFeeBps),
    routeSurchargeBps: Number(routeSurchargeBps),
  };
}

export function formatFeeBps(feeBps: number | undefined): string {
  if (feeBps === undefined) return "--";
  return `${feeBps / 100}%`;
}
