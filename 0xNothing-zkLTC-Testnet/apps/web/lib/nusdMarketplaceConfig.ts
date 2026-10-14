import { PUMP_NUSD_ADDRESS } from "./publicConfig";
import { NUSD_MARKET_IMPLEMENTATION, nusdMarketplaceAddress } from "./nusdMarketplace";
import deployment from "./nusdMarketplace.generated.json";
import testnet from "@fi/config/testnet.generated.json";

export const NFT_NUSD_ADDRESS = PUMP_NUSD_ADDRESS;
const override = process.env.NEXT_PUBLIC_PIXEL_NUSD_MARKETPLACE_ADDRESS?.trim();
const verifiedDefault = deployment.chainId === 4441
  && deployment.nusd.toLowerCase() === NFT_NUSD_ADDRESS.toLowerCase()
  && deployment.implementation === NUSD_MARKET_IMPLEMENTATION
  ? deployment.address : undefined;
export const NUSD_MARKETPLACE_ADDRESS = nusdMarketplaceAddress(override || verifiedDefault);
/** Deployed subgraphs/0xpixel-nusd-market (v2); the server env PIXEL_NUSD_SUBGRAPH_URL overrides it. */
export const NUSD_SUBGRAPH_URL = testnet.nusdMarketGoldskyEndpoint;
