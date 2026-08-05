"use client";

import { useQuery } from "@tanstack/react-query";
import { getAddress, type Address } from "viem";
import { assetList } from "@/config/assets";
import { fiPath } from "@/config/paths";
import type { DataEnvelope, PoolPoint } from "@/lib/data";

export interface SwapAsset {
  id: string;
  symbol: string;
  name: string;
  decimals: number;
  address?: Address;
  poolAddress?: Address;
  native: boolean;
  graduated: boolean;
}

const CORE_ASSETS: SwapAsset[] = assetList.map((asset) => ({
  id: asset.symbol,
  symbol: asset.symbol,
  name: asset.name,
  decimals: asset.decimals,
  address: asset.address,
  poolAddress: asset.poolAddress,
  native: asset.native,
  graduated: false,
}));

export function useSwapAssets() {
  return useQuery({
    queryKey: ["swap-assets"],
    queryFn: async (): Promise<SwapAsset[]> => {
      const response = await fetch(fiPath("/api/data/pools"), { cache: "no-store" });
      if (!response.ok) return CORE_ASSETS;
      const payload = (await response.json()) as DataEnvelope<PoolPoint[]>;
      const known = new Set(CORE_ASSETS.map((asset) => asset.poolAddress?.toLowerCase()).filter(Boolean));
      const discovered: SwapAsset[] = [];
      for (const pool of payload.data) {
        const liquid = BigInt(pool.totalSupply || "0") > 0n
          || (BigInt(pool.reserve0 || "0") > 0n && BigInt(pool.reserve1 || "0") > 0n);
        if (!liquid) continue;
        for (const token of [pool.token0, pool.token1]) {
          if (known.has(token.id.toLowerCase())) continue;
          const address = getAddress(token.id);
          known.add(address.toLowerCase());
          discovered.push({
            id: address.toLowerCase(),
            symbol: token.symbol,
            name: token.name,
            decimals: token.decimals,
            address,
            poolAddress: address,
            native: false,
            graduated: pool.protectedBootstrap,
          });
        }
      }
      discovered.sort((a, b) => a.symbol.localeCompare(b.symbol));
      return [...CORE_ASSETS, ...discovered];
    },
    initialData: CORE_ASSETS,
    staleTime: 20_000,
    refetchInterval: 30_000,
  });
}
