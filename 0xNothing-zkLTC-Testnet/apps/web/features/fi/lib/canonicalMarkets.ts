import type { Address } from "viem";
import { deployment } from "@fi/config/deployment";

export interface CanonicalOracleMarket {
  slug: "zkltc-nusd" | "nbtc-nusd" | "neth-nusd";
  pool?: Address;
  oracle?: Address;
}

export const canonicalOracleMarkets: readonly CanonicalOracleMarket[] = [
  {
    slug: "zkltc-nusd",
    pool: deployment.contracts.wzkLtcNusdPair,
    oracle: deployment.contracts.ltcOracle,
  },
  {
    slug: "nbtc-nusd",
    pool: deployment.contracts.nbtcNusdPair,
    oracle: deployment.contracts.btcOracle,
  },
  {
    slug: "neth-nusd",
    pool: deployment.contracts.nethNusdPair,
    oracle: deployment.contracts.ethOracle,
  },
] as const;

export function canonicalOracleMarketForIdentifier(identifier: string): CanonicalOracleMarket | undefined {
  const normalized = identifier.toLowerCase();
  return canonicalOracleMarkets.find((market) => (
    market.slug === normalized || market.pool?.toLowerCase() === normalized
  ));
}

