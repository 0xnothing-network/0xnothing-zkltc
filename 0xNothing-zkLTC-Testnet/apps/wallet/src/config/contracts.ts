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
  nusd: "0x1d041A8e575006D46Ae0Aa2E4869C5be0327874E",
  wzkltc: "0xE93d4373CE1eDA3df6c3Ab7ed3ab07A07aA5939F",
  nbtc: "0x08Cd6E2B93e4422cf84F2769D9D7c0b2AAa29a5A",
  neth: "0xE227A4e18F14D026720AfE582dF001Bc5Ac69eA1",
  dexFactory: "0x1D1dFE055F261DB4B27962A9c3097e779dD8ac58",
  dexRouter: "0xF33fCB0Bd0795EAcbe4b1BB4E8c3d904483847F5",
  /** 0xFi lending remains separate from fixed-duration NUSD staking. */
  lendingPool: "0xF37eCaed4E7869850071BB9439E32C917F60F080",
  /** Locks NUSD for 0xPoints and pays 10,000 NUSD reward rounds by share of points. */
  rewardStaking: "0x735DFf17Df61F0bF1034603BcdE02f8Fa7B8CaE4",
  /**
   * The DIA LTC/USD adapter NUSD itself is bound to — every mint and redeem is
   * priced through this contract, so it is also what the wallet shows. Used as
   * the fallback when `NUSD.oracle()` cannot be read; see services/nusdOracle.
   */
  nusdOracleAdapter: "0x3579B31e3241DE60F5F9462B3E0d759F346a49c8",
  diaLtcFeed: "0x45dDa5d881BD2C917976CCfde74fFd6f6412da29",
  pumpFactory: "0x87Ae7e019C2e511eE97310215d5Ae358c28F47D9",
  pixelNft: "0xd83cb7acef921f98b6b983cbb712a583869da9eb",
  pixelClassicNft: "0x33A32b9b2BEe864f9e42BFa39cA7BDC72f655988",
  pixelMarketplace: "0x13337cadA78d53C90E3c0EcE44C17c467C1a86F4",
} as const satisfies Record<string, Address>;

/** First block of the 0xFi deployment — the floor for any log scan. */
export const FI_DEPLOYMENT_BLOCK = 60_811_550n;
export const PIXEL_START_BLOCK = 56_305_414n;
export const PIXEL_CLASSIC_START_BLOCK = 24_867_130n;

/** NFT identity always includes its collection: both collections start at #1. */
export const PIXEL_COLLECTIONS = [
  { address: CONTRACTS.pixelNft, name: "0xPixel", startBlock: PIXEL_START_BLOCK },
  { address: CONTRACTS.pixelClassicNft, name: "0xPixel Classic", startBlock: PIXEL_CLASSIC_START_BLOCK },
].filter((collection) => !/^0x0{40}$/iu.test(collection.address));

export const IPFS_GATEWAY_URL = "https://dweb.link/ipfs/";
