import { zeroAddress, type Address } from "viem";
import { deployment } from "@/config/deployment";

export type AssetSymbol = "zkLTC" | "NUSD" | "nBTC" | "nETH";

export interface AssetConfig {
  symbol: AssetSymbol;
  name: string;
  decimals: number;
  address?: Address;
  poolAddress?: Address;
  native: boolean;
  oracleKey?: string;
}

export const assets: Record<AssetSymbol, AssetConfig> = {
  zkLTC: {
    symbol: "zkLTC",
    name: "Litecoin",
    decimals: 18,
    address: zeroAddress,
    poolAddress: deployment.contracts.wzkltc,
    native: true,
    oracleKey: "LTC/USD",
  },
  NUSD: {
    symbol: "NUSD",
    name: "Nothing USD",
    decimals: 18,
    address: deployment.contracts.nusd,
    poolAddress: deployment.contracts.nusd,
    native: false,
  },
  nBTC: {
    symbol: "nBTC",
    name: "Nothing Bitcoin",
    decimals: 18,
    address: deployment.contracts.nbtc,
    poolAddress: deployment.contracts.nbtc,
    native: false,
    oracleKey: "BTC/USD",
  },
  nETH: {
    symbol: "nETH",
    name: "Nothing Ether",
    decimals: 18,
    address: deployment.contracts.neth,
    poolAddress: deployment.contracts.neth,
    native: false,
    oracleKey: "ETH/USD",
  },
};

export const assetList = Object.values(assets);

export const canonicalPairs = [
  ["zkLTC", "NUSD"],
  ["nBTC", "NUSD"],
  ["nETH", "NUSD"],
] as const satisfies ReadonlyArray<readonly [AssetSymbol, AssetSymbol]>;

export function assetForPool(symbol: AssetSymbol): Address | undefined {
  return assets[symbol].poolAddress;
}

export function pairSlug(tokenA: AssetSymbol, tokenB: AssetSymbol): string {
  return `${tokenA}-${tokenB}`.toLowerCase();
}

export function parsePairSlug(slug: string): readonly [AssetSymbol, AssetSymbol] | undefined {
  const normalized = slug.toLowerCase();
  return canonicalPairs.find(([tokenA, tokenB]) => pairSlug(tokenA, tokenB) === normalized);
}

export function deployedPairForSlug(slug: string): Address | undefined {
  switch (slug.toLowerCase()) {
    case "zkltc-nusd": return deployment.contracts.wzkLtcNusdPair;
    case "nbtc-nusd": return deployment.contracts.nbtcNusdPair;
    case "neth-nusd": return deployment.contracts.nethNusdPair;
    default: return undefined;
  }
}
