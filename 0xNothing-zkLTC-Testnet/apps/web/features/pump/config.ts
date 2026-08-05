import type { Address } from "viem";
import {
  IPFS_GATEWAY_URL,
  PUMP_FACTORY_ADDRESS,
  PUMP_GRADUATION_ADAPTER_ADDRESS,
  PUMP_GRADUATION_ROUTER_ADDRESS,
  PUMP_NUSD_ADDRESS,
  PUMP_START_BLOCK,
  PUMP_SUBGRAPH_URL,
} from "@/lib/publicConfig";

export {
  IPFS_GATEWAY_URL,
  PUMP_FACTORY_ADDRESS,
  PUMP_GRADUATION_ADAPTER_ADDRESS,
  PUMP_GRADUATION_ROUTER_ADDRESS,
  PUMP_NUSD_ADDRESS,
  PUMP_START_BLOCK,
  PUMP_SUBGRAPH_URL,
};

export const ZERO_ADDRESS: Address = "0x0000000000000000000000000000000000000000";

export const PUMP_CHAIN_ID = 4441 as const;

export const PUMP_CREATE_FEE = 1_000_000_000_000_000_000n;
export const PUMP_BPS_DENOMINATOR = 10_000n;
export const PUMP_CONFIGURED = PUMP_FACTORY_ADDRESS !== ZERO_ADDRESS;
export const NUSD_CONFIGURED = PUMP_NUSD_ADDRESS !== ZERO_ADDRESS;

export function ipfsToGatewayUrl(uri: string): string {
  if (!uri) return "";
  if (uri.startsWith("ipfs://")) {
    const cidPath = uri.slice("ipfs://".length).replace(/^ipfs\//, "");
    const [cid, ...pathParts] = cidPath.split("/");
    if (/^b[a-z2-7]{20,}$/i.test(cid)) {
      const path = pathParts.length > 0 ? `/${pathParts.join("/")}` : "/";
      return `https://${cid.toLowerCase()}.ipfs.dweb.link${path}`;
    }
    return `${IPFS_GATEWAY_URL}${cidPath}`;
  }
  return /^https?:\/\//i.test(uri) ? uri : "";
}
