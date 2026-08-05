"use client";

import { useAccount, useBalance, useReadContract } from "wagmi";
import { assets, type AssetSymbol } from "@/config/assets";
import { erc20Abi } from "@/lib/abis/erc20";

export function useAssetBalance(symbol: AssetSymbol) {
  const { address } = useAccount();
  const asset = assets[symbol];
  const native = useBalance({ address, query: { enabled: Boolean(address && asset.native) } });
  const token = useReadContract({
    address: asset.address,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    query: { enabled: Boolean(address && !asset.native && asset.address) },
  });
  return {
    data: asset.native ? native.data?.value : token.data,
    refetch: asset.native ? native.refetch : token.refetch,
    isLoading: asset.native ? native.isLoading : token.isLoading,
  };
}

