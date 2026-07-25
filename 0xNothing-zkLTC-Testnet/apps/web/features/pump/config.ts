import type { Address } from "viem";

export const ZERO_ADDRESS: Address = "0x0000000000000000000000000000000000000000";

function publicAddress(value: string | undefined): Address {
  return value && /^0x[0-9a-fA-F]{40}$/.test(value)
    ? (value as Address)
    : ZERO_ADDRESS;
}

function publicBigInt(value: string | undefined): bigint {
  try {
    return value && /^\d+$/.test(value) ? BigInt(value) : 0n;
  } catch {
    return 0n;
  }
}

export const PUMP_CHAIN_ID = 4441 as const;
export const PUMP_FACTORY_ADDRESS = publicAddress(
  process.env.NEXT_PUBLIC_PUMP_FACTORY_ADDRESS,
);
export const PUMP_NUSD_ADDRESS = publicAddress(process.env.NEXT_PUBLIC_NUSD_ADDRESS);
export const PUMP_START_BLOCK = publicBigInt(process.env.NEXT_PUBLIC_PUMP_START_BLOCK);
export const PUMP_SUBGRAPH_URL = process.env.NEXT_PUBLIC_PUMP_SUBGRAPH_URL?.trim() ?? "";
export const IPFS_GATEWAY_URL = (
  process.env.NEXT_PUBLIC_IPFS_GATEWAY_URL?.trim() ||
  "https://gateway.pinata.cloud/ipfs/"
).replace(/\/*$/, "/");

export const PUMP_CREATE_FEE = 1_000_000_000_000_000_000n;
export const PUMP_BPS_DENOMINATOR = 10_000n;
export const PUMP_CONFIGURED = PUMP_FACTORY_ADDRESS !== ZERO_ADDRESS;
export const NUSD_CONFIGURED = PUMP_NUSD_ADDRESS !== ZERO_ADDRESS;

export function ipfsToGatewayUrl(uri: string): string {
  if (!uri) return "";
  if (uri.startsWith("ipfs://")) {
    const cidPath = uri.slice("ipfs://".length).replace(/^ipfs\//, "");
    return `${IPFS_GATEWAY_URL}${cidPath}`;
  }
  return /^https?:\/\//i.test(uri) ? uri : "";
}
