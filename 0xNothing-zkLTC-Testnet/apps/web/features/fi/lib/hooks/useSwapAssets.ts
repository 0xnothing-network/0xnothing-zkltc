"use client";

import { useMemo } from "react";
import { getAddress, type Address } from "viem";
import { assetList } from "@fi/config/assets";
import type { ImportedTokenExplorerStatus, ImportedTokenMetadataSource } from "@fi/lib/importedToken";
import { usePools } from "@fi/lib/hooks/usePools";

export interface SwapAsset {
  id: string;
  symbol: string;
  name: string;
  decimals: number;
  address?: Address;
  poolAddress?: Address;
  native: boolean;
  graduated: boolean;
  imageUrl?: string;
  imported?: boolean;
  trustedCore: boolean;
  explorerStatus?: ImportedTokenExplorerStatus;
  metadataSource?: ImportedTokenMetadataSource;
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
  trustedCore: true,
}));

export function useSwapAssets() {
  const poolsQuery = usePools();
  const data = useMemo((): SwapAsset[] => {
      const known = new Set(CORE_ASSETS.map((asset) => asset.poolAddress?.toLowerCase()).filter(Boolean));
      const discovered: SwapAsset[] = [];
      for (const pool of poolsQuery.data ?? []) {
        let liquid = false;
        try {
          liquid = BigInt(pool.totalSupply || "0") > 0n
            || (BigInt(pool.reserve0 || "0") > 0n && BigInt(pool.reserve1 || "0") > 0n);
        } catch {
          continue;
        }
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
            imageUrl: token.imageUrl,
            trustedCore: false,
          });
        }
      }
      discovered.sort((a, b) => a.symbol.localeCompare(b.symbol));
      return [...CORE_ASSETS, ...discovered];
  }, [poolsQuery.data]);

  return { ...poolsQuery, data };
}
