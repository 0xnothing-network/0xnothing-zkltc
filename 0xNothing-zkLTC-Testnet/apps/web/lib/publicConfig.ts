import type { Address } from "viem";

/** Public LitVM testnet configuration. Nothing in this file is secret. */
export const PUBLIC_APP_URL = "https://0xnothing.net" as const;
export const LITVM_RPC_URL = "https://liteforge.rpc.caldera.xyz/infra-partner-http" as const;
export const LITVM_EXPLORER_URL = "https://liteforge.explorer.caldera.xyz" as const;
export const MULTICALL3_ADDRESS: Address = "0xca11bde05977b3631167028862be2a173976ca11";

export const PIXEL_NFT_ADDRESS: Address = "0x33A32b9b2BEe864f9e42BFa39cA7BDC72f655988";
export const PIXEL_MARKETPLACE_ADDRESS: Address = "0x13337cadA78d53C90E3c0EcE44C17c467C1a86F4";

export const PIXEL_START_BLOCK = 24_867_130n;
export const MARKETPLACE_START_BLOCK = 24_867_505n;
export const MARKETPLACE_SUBGRAPH_URL =
  "https://api.goldsky.com/api/public/project_cmr0mev6548fr01xtd92rc135/subgraphs/marketplace/1.0.1/gn" as const;

export const PUMP_FACTORY_ADDRESS: Address = "0x4a0eaf310e3659aa9b360fd44e90208c31dbe0e2";
export const PUMP_NUSD_ADDRESS: Address = "0x5317e21aba902c6c7087a84457bc02ffe99604d1";
export const PUMP_START_BLOCK = 32_907_625n;
export const PUMP_SUBGRAPH_URL =
  "https://api.goldsky.com/api/public/project_cmqmpust19i8v01t595z8hpq4/subgraphs/zeroxpump-testnet/staging/gn" as const;
