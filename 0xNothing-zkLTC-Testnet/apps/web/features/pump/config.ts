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

const CID_V0_PATTERN = /^Qm[1-9A-HJ-NP-Za-km-z]{44}$/;
const CID_V1_BASE32_PATTERN = /^b[a-z2-7]{20,}$/i;
const IPFS_PATH_SEGMENT_PATTERN = /^[a-zA-Z0-9._~-]{1,128}$/;

/**
 * Return a conservative CID/path suitable for a fixed IPFS gateway URL.
 * Keeping this parser shared by the browser and image proxy prevents an
 * on-chain URI from turning the proxy into an arbitrary URL fetcher.
 */
export function normalizePumpIpfsPath(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 512) return "";

  const withoutScheme = trimmed.replace(/^ipfs:\/\//i, "").replace(/^ipfs\//i, "");
  if (!withoutScheme || /[%?#\\]/.test(withoutScheme)) return "";

  const segments = withoutScheme.split("/");
  const cid = segments.shift() ?? "";
  if (!CID_V0_PATTERN.test(cid) && !CID_V1_BASE32_PATTERN.test(cid)) return "";
  if (
    segments.length > 8
    || segments.some(
      (segment) =>
        segment === "."
        || segment === ".."
        || !IPFS_PATH_SEGMENT_PATTERN.test(segment),
    )
  ) {
    return "";
  }

  const normalizedCid = cid.startsWith("Qm") ? cid : cid.toLowerCase();
  return [normalizedCid, ...segments].join("/");
}

export function ipfsToGatewayUrl(uri: string): string {
  if (!uri) return "";
  if (uri.startsWith("ipfs://")) {
    const cidPath = normalizePumpIpfsPath(uri);
    if (!cidPath) return "";
    const [cid, ...pathParts] = cidPath.split("/");
    if (cid.startsWith("b")) {
      const path = pathParts.length > 0 ? `/${pathParts.join("/")}` : "/";
      return `https://${cid}.ipfs.dweb.link${path}`;
    }
    return `${IPFS_GATEWAY_URL}${cidPath}`;
  }
  return /^https?:\/\//i.test(uri) ? uri : "";
}

const MAX_EXTERNAL_URL_LENGTH = 2_048;

/**
 * Canonical check for user-supplied external links (metadata website/social,
 * token-creation form, upload API). Shared by browser and server so on-chain
 * metadata from any source follows one allowlist.
 */
export function normalizePumpExternalUrl(
  value: string,
  maxLength = MAX_EXTERNAL_URL_LENGTH,
): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maxLength) return "";
  try {
    const url = new URL(trimmed);
    return url.protocol === "https:" ? url.href : "";
  } catch {
    return "";
  }
}

export function isValidPumpExternalUrl(value: string, maxLength = MAX_EXTERNAL_URL_LENGTH): boolean {
  return Boolean(normalizePumpExternalUrl(value, maxLength));
}

/** Same-origin, content-addressed image URL used by 0xPump logo components. */
export function getPumpImageUrl(uri: string): string {
  const cidPath = normalizePumpIpfsPath(uri);
  if (uri.trim().toLowerCase().startsWith("ipfs://") && cidPath) {
    return `/api/pump/image?cid=${encodeURIComponent(cidPath)}`;
  }

  return normalizePumpExternalUrl(uri);
}
