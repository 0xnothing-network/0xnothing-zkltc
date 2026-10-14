import type { Address } from "viem";
import testnet from "@fi/config/testnet.generated.json";

/** Public LitVM testnet configuration. Nothing in this file is secret. */
export const PUBLIC_APP_URL = "https://0xnothing.xyz" as const;
export const LITVM_RPC_URL = "https://liteforge.rpc.caldera.xyz/infra-partner-http" as const;
/** Public endpoint on the same origin, used automatically when the primary fails. */
export const LITVM_RPC_FALLBACK_URL = "https://liteforge.rpc.caldera.xyz/http" as const;
/** Log subscriptions that push chain events to the browser; tried in order on reconnect. */
export const LITVM_WS_URLS = [
  "wss://liteforge.rpc.caldera.xyz/infra-partner-ws",
  "wss://liteforge.rpc.caldera.xyz/ws",
] as const;
export const LITVM_EXPLORER_URL = "https://liteforge.explorer.caldera.xyz" as const;
export const MULTICALL3_ADDRESS: Address = "0xca11bde05977b3631167028862be2a173976ca11";

export const PIXEL_CLASSIC_ADDRESS: Address = "0x33A32b9b2BEe864f9e42BFa39cA7BDC72f655988";
/** The collection new artwork is minted to; the Classic collection stays readable. */
export const PIXEL_NFT_ADDRESS: Address = "0xd83cb7acef921f98b6b983cbb712a583869da9eb";
export const PIXEL_START_BLOCK = 56_305_414n;

export const PIXEL_CLASSIC_START_BLOCK = 24_867_130n;

// 0xPump and NUSD come from the active testnet set written by the 0xFi deploy script's --publish step.
export const PUMP_FACTORY_ADDRESS = testnet.pump as Address;
export const PUMP_NUSD_ADDRESS = testnet.nusd as Address;
export const PUMP_GRADUATION_ROUTER_ADDRESS = testnet.pumpGraduationRouter as Address;
export const PUMP_GRADUATION_ADAPTER_ADDRESS = testnet.pumpGraduationAdapter as Address;
export const PUMP_GRADUATION_CONTROLLER_ADDRESS = testnet.pumpGraduationController as Address;
export const PUMP_START_BLOCK = BigInt(testnet.deploymentBlock);
export const PUMP_SUBGRAPH_URL = testnet.pumpGoldskyEndpoint;
export const IPFS_GATEWAY_URL = "https://dweb.link/ipfs/" as const;
