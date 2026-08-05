"use client";

import type { Address } from "viem";
import { useAccount, useReadContract } from "wagmi";
import { erc20Abi } from "@fi/lib/abis/erc20";

export function useTokenBalance(token?: Address) {
  const { address } = useAccount();
  const query = useReadContract({
    address: token,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    query: { enabled: Boolean(token && address), refetchInterval: 12_000 },
  });
  return { data: query.data, refetch: query.refetch, isLoading: query.isLoading };
}
