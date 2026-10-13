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
  nusd: "0x677D63c78E77E0b1971530e1494Caee4Bd7d631e",
  wzkltc: "0x3d09BcE3C571679125C1Ecad0cfB227ac9Ea4e69",
  nbtc: "0x18A8877a2937eacAB552B5E370F635a62F81B1d7",
  neth: "0x6Df5aEC35747102422d68945E4ee20f18cc88372",
  dexFactory: "0xc3B99e993eBAF776BFF01fa8a019Fe6d4334de52",
  dexRouter: "0x1A5a1901C193175aA7D25502f4736D550D969458",
  /** 0xFi lending remains separate from fixed-duration NUSD points staking. */
  lendingPool: "0x34ACc957ef5BACEE97b9056BE2C5A910eE7022b8",
  /** Locks NUSD for fixed terms and accounts xPoints on-chain. */
  nusdPointsStaking: "0xA5B2f5c3c67198Bf1B99aA6837CdFe33dA85f480",
  /**
   * The DIA LTC/USD adapter NUSD itself is bound to — every mint and redeem is
   * priced through this contract, so it is also what the wallet shows. Used as
   * the fallback when `NUSD.oracle()` cannot be read; see services/nusdOracle.
   */
  nusdOracleAdapter: "0x6d18728bCB57c3Ce7DFb5A522fF22836280D6C98",
  diaLtcFeed: "0x45dDa5d881BD2C917976CCfde74fFd6f6412da29",
  pumpFactory: "0x4749773fB552315d8aCf18A052847567e0E88030",
  pixelNft: "0xd83cb7acef921f98b6b983cbb712a583869da9eb",
  pixelLegacyNft: "0x33A32b9b2BEe864f9e42BFa39cA7BDC72f655988",
  pixelMarketplace: "0x13337cadA78d53C90E3c0EcE44C17c467C1a86F4",
} as const satisfies Record<string, Address>;

/** First block of the 0xFi deployment — the floor for any log scan. */
export const FI_DEPLOYMENT_BLOCK = 35_303_686n;
export const PIXEL_START_BLOCK = 56_305_414n;
export const PIXEL_LEGACY_START_BLOCK = 24_867_130n;

/** NFT identity always includes its collection: both collections start at #1. */
export const PIXEL_COLLECTIONS = [
  { address: CONTRACTS.pixelNft, name: "0xPixel V2", startBlock: PIXEL_START_BLOCK },
  { address: CONTRACTS.pixelLegacyNft, name: "0xPixel", startBlock: PIXEL_LEGACY_START_BLOCK },
].filter((collection) => !/^0x0{40}$/iu.test(collection.address));

export const IPFS_GATEWAY_URL = "https://dweb.link/ipfs/";
