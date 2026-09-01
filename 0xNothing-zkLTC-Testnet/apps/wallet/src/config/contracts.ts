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
  nusd: "0x5317e21aba902c6c7087a84457bc02fFe99604d1",
  wzkltc: "0xE93d4373CE1eDA3df6c3Ab7ed3ab07A07aA5939F",
  nbtc: "0x0CBc1e968db77885DCa648D7bD0e80fCc94cB9Cf",
  neth: "0xD504bB9430d94ccFF87e12e94fd6C0074D0E8aCb",
  dexFactory: "0xe33fE815c2e12DC83b69397CeD12b09849Fa9C0D",
  dexRouter: "0x7b17035A4aC3A32f2A18a16e2F43A5f8C66275b0",
  /** 0xFi lending remains separate from fixed-duration NUSD points staking. */
  lendingPool: "0x7CB638F8e10f1bd200A3c5C3fD014C3FD97BA914",
  /** Locks NUSD for fixed terms and accounts xPoints on-chain. */
  nusdPointsStaking: "0xDf009d9c2Bc0C2f8ee55A047074edB166C1D3282",
  /**
   * The DIA LTC/USD adapter NUSD itself is bound to — every mint and redeem is
   * priced through this contract, so it is also what the wallet shows. Used as
   * the fallback when `NUSD.oracle()` cannot be read; see services/nusdOracle.
   */
  nusdOracleAdapter: "0x3579B31e3241DE60F5F9462B3E0d759F346a49c8",
  diaLtcFeed: "0x45dDa5d881BD2C917976CCfde74fFd6f6412da29",
  pumpFactory: "0x4a0Eaf310e3659aA9B360fD44e90208c31Dbe0e2",
  pixelNft: "0x33A32b9b2BEe864f9e42BFa39cA7BDC72f655988",
  pixelMarketplace: "0x13337cadA78d53C90E3c0EcE44C17c467C1a86F4",
} as const satisfies Record<string, Address>;

/** First block of the 0xFi deployment — the floor for any log scan. */
export const FI_DEPLOYMENT_BLOCK = 35_303_686n;
export const PIXEL_START_BLOCK = 24_867_130n;

export const IPFS_GATEWAY_URL = "https://dweb.link/ipfs/";
