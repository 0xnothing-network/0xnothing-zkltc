"use client";

import { useQuery } from "@tanstack/react-query";
import { erc20Abi, type Abi } from "viem";
import { useAccount, usePublicClient } from "wagmi";
import { deployment } from "@fi/config/deployment";
import { rwaMarketAbi, rwaOracleAbi } from "../../../../../../shared/rwa/abi";
import { decodeQuote, readRwaState, type RwaMarketConfig } from "../../../../../../shared/rwa/core";

const readAbi: Abi = [...rwaMarketAbi, ...rwaOracleAbi, ...erc20Abi];

export function useRwaMarket(config: RwaMarketConfig, buy: boolean, amount: bigint | null) {
  const { address } = useAccount();
  const client = usePublicClient({ chainId: deployment.chain.id });
  const state = useQuery({
    queryKey: ["rwa-state", config.chainId, config.market, address],
    queryFn: async () => {
      if (!client || config.chainId !== deployment.chain.id) throw new Error("RWA network unavailable");
      const block = await client.getBlock();
      return readRwaState((contract, functionName, args) => client.readContract({
        address: contract, abi: readAbi, functionName, args, blockNumber: block.number,
      }), config, address);
    },
    enabled: Boolean(client), refetchInterval: 12_000, retry: 1,
  });
  const quote = useQuery({
    queryKey: ["rwa-quote", config.chainId, config.market, address, buy, amount?.toString()],
    queryFn: async () => {
      if (!client || !amount) throw new Error("Enter an amount");
      const block = await client.getBlock();
      const values = decodeQuote(await client.readContract({ address: config.market,
        abi: rwaMarketAbi, functionName: "quote", args: [buy, amount], blockNumber: block.number }));
      return { values, deadline: block.timestamp + 300n };
    },
    enabled: Boolean(client && amount && state.data && !state.isError && !state.data.paused && state.data.price),
    refetchInterval: 12_000, retry: false,
  });
  return { state, quote };
}
