"use client";

import type { Address } from "viem";
import { useAccount, useReadContract } from "wagmi";
import { deployment } from "@fi/config/deployment";
import { erc20Abi } from "@fi/lib/abis/erc20";

export function useTokenBalance(token?: Address) {
  const { address } = useAccount();
  const query = useReadContract({
    chainId: deployment.chain.id,
    address: token,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    query: { enabled: Boolean(token && address) },
  });
  return { data: query.data, refetch: query.refetch, isLoading: query.isLoading };
}
