import type { Address } from "viem";

/**
 * Deployed testnet addresses, mirrored from
 * apps/web/features/fi/config/testnet.generated.json and
 * apps/web/lib/publicConfig.ts.
 *
 * Only the surfaces the wallet actually touches are listed; farms, vaults,
 * gauges and the synth stack stay in the web app.
 */
export const CONTRACTS = {
  /** NUSD is the ERC-20 *and* the oracle mint/redeem module. */
  nusd: "0x69320A82ACCeC1b8A5EF59fd02b217e7ea4aEa19",
  wzkltc: "0xE93d4373CE1eDA3df6c3Ab7ed3ab07A07aA5939F",
  nbtc: "0xAA612e178ff9c4Ea044eF507670C7502D58CbA46",
  neth: "0x3f3B4F9DfE1AE3CDaa89788810557194c662a8Ef",
  dexFactory: "0xc6B675d701a168789A5cc7Dd04Ef9e531886114c",
  dexRouter: "0x1cda4793122a223A09be54ED5f664ba222eEe042",
  /** 0xFi lending remains separate from fixed-duration NUSD staking. */
  lendingPool: "0x6Cc96c044321b3205Ac108107Fc6d2d47e0B3E44",
  /** Locks NUSD for 0xPoints and streams 70% of every NUSD fee to stakers over 7 days. */
  rewardStaking: "0x59589d9a5840D2CEF7A6e4A8cB55C258cc73E483",
  /**
   * The LTC/USD oracle router NUSD itself is bound to — every mint and redeem is
   * priced through this contract, so it is also what the wallet shows. Used as
   * the fallback when `NUSD.oracle()` cannot be read; see services/nusdOracle.
   */
  nusdOracleAdapter: "0xf9CCF611b7c4e642852D3d1a7A6C3883985A2962",
  diaLtcFeed: "0x45dDa5d881BD2C917976CCfde74fFd6f6412da29",
  pumpFactory: "0x0239baEc3c695A6EA893Ad90a7608112e0580526",
  pixelNft: "0xd83cb7acef921f98b6b983cbb712a583869da9eb",
  pixelClassicNft: "0x33A32b9b2BEe864f9e42BFa39cA7BDC72f655988",
  pixelMarketplace: "0x13337cadA78d53C90E3c0EcE44C17c467C1a86F4",
} as const satisfies Record<string, Address>;

/** First block of the 0xFi deployment — the floor for any log scan. */
export const FI_DEPLOYMENT_BLOCK = 61_141_359n;
export const PIXEL_START_BLOCK = 56_305_414n;
export const PIXEL_CLASSIC_START_BLOCK = 24_867_130n;

/** NFT identity always includes its collection: both collections start at #1. */
export const PIXEL_COLLECTIONS = [
  { address: CONTRACTS.pixelNft, name: "0xPixel", startBlock: PIXEL_START_BLOCK },
  { address: CONTRACTS.pixelClassicNft, name: "0xPixel Classic", startBlock: PIXEL_CLASSIC_START_BLOCK },
].filter((collection) => !/^0x0{40}$/iu.test(collection.address));

export const IPFS_GATEWAY_URL = "https://dweb.link/ipfs/";
