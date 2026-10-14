import { PIXEL_MARKET_NUSD_ADDRESS } from "./publicConfig";
import { NUSD_MARKET_IMPLEMENTATION, nusdMarketplaceAddress } from "./nusdMarketplace";
import deployment from "./nusdMarketplace.generated.json";

export const NFT_NUSD_ADDRESS = PIXEL_MARKET_NUSD_ADDRESS;
const override = process.env.NEXT_PUBLIC_PIXEL_NUSD_MARKETPLACE_ADDRESS?.trim();
const verifiedDefault = deployment.chainId === 4441
  && deployment.nusd.toLowerCase() === NFT_NUSD_ADDRESS.toLowerCase()
  && deployment.implementation === NUSD_MARKET_IMPLEMENTATION
  ? deployment.address : undefined;
export const NUSD_MARKETPLACE_ADDRESS = nusdMarketplaceAddress(override || verifiedDefault);
