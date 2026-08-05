"use client";

import { zeroAddress, type Address } from "viem";
import { useReadContract } from "wagmi";
import { deployment } from "@/config/deployment";
import { dexFactoryAbi } from "@/lib/abis/dex";

export function useActiveDexRouter(): Address | undefined {
  const activeRouter = useReadContract({
    address: deployment.contracts.dexFactory,
    abi: dexFactoryAbi,
    functionName: "router",
    query: {
      enabled: Boolean(deployment.contracts.dexFactory),
      refetchInterval: 10_000,
      retry: false,
    },
  });

  if (deployment.contracts.dexFactory && activeRouter.isPending) {
    return undefined;
  }

  return activeRouter.data && activeRouter.data !== zeroAddress
    ? activeRouter.data
    : deployment.contracts.dexRouter;
}
