import { defineChain, type Chain } from "viem";
import {
  LITVM_CHAIN_ID,
  LITVM_EXPLORER_URL,
  LITVM_RPC_URL,
  litvm,
} from "./chain";

const MAX_NAME_LENGTH = 48;
const MAX_SYMBOL_LENGTH = 12;
const MAX_RPC_LENGTH = 2_048;
const MAX_CUSTOM_NETWORKS = 32;
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export interface NetworkCurrency {
  name: string;
  symbol: string;
  decimals: number;
}

export interface WalletNetwork {
  /** Stable local identifier; never used as a chain identifier on wire. */
  id: string;
  name: string;
  chainId: number;
  rpcUrl: string;
  explorerUrl: string;
  nativeCurrency: NetworkCurrency;
  builtin: boolean;
}

export const LITVM_NETWORK: WalletNetwork = {
  id: "litvm-4441",
  name: "LitVM LiteForge",
  chainId: LITVM_CHAIN_ID,
  rpcUrl: LITVM_RPC_URL,
  explorerUrl: LITVM_EXPLORER_URL,
  nativeCurrency: { name: "zkLTC", symbol: "zkLTC", decimals: 18 },
  builtin: true,
};

/** The app's built-in network remains first and cannot be deleted. */
export const BUILTIN_NETWORKS: readonly WalletNetwork[] = [LITVM_NETWORK];

export function networkHex(chainId: number): string {
  return `0x${chainId.toString(16)}`;
}

export function txUrlFor(network: WalletNetwork, hash: string): string | undefined {
  return network.explorerUrl ? `${network.explorerUrl}/tx/${hash}` : undefined;
}

export function addressUrlFor(network: WalletNetwork, address: string): string | undefined {
  return network.explorerUrl ? `${network.explorerUrl}/address/${address}` : undefined;
}

export function isLitvmNetwork(network: WalletNetwork): boolean {
  return network.id === LITVM_NETWORK.id;
}

export function customNetworkId(chainId: number, rpcUrl: string): string {
  const normalized = normalizeRpcUrl(rpcUrl) ?? rpcUrl.trim();
  let hash = 2166136261;
  for (const char of `${chainId}:${normalized}`) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return `custom-${chainId}-${(hash >>> 0).toString(16)}`;
}

/**
 * Validate a user-entered RPC endpoint without accepting credentials,
 * javascript/data URLs, or non-local plaintext endpoints. Local HTTP is kept
 * available for a developer's node; production endpoints must use HTTPS.
 */
export function normalizeRpcUrl(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_RPC_LENGTH) return null;
  try {
    const url = new URL(trimmed);
    const local = LOOPBACK_HOSTS.has(url.hostname.toLowerCase());
    if (
      (url.protocol !== "https:" && !(url.protocol === "http:" && local))
      || url.username
      || url.password
      || url.hash
    ) return null;
    return url.toString();
  } catch {
    return null;
  }
}

export function normalizeExplorerUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_RPC_LENGTH) return "";
  try {
    const url = new URL(trimmed);
    const local = LOOPBACK_HOSTS.has(url.hostname.toLowerCase());
    if (
      (url.protocol !== "https:" && !(url.protocol === "http:" && local))
      || url.username
      || url.password
      || url.hash
    ) return "";
    return url.toString().replace(/\/$/u, "");
  } catch {
    return "";
  }
}

function safeText(value: unknown, maxLength: number): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= maxLength && !/[\u0000-\u001f\u007f]/.test(trimmed)
    ? trimmed
    : "";
}

function safeChainId(value: unknown): number | null {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

/** Converts untrusted persisted form data into a safe custom network. */
export function sanitizeCustomNetwork(input: unknown): WalletNetwork | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const value = input as Record<string, unknown>;
  const chainId = safeChainId(value.chainId);
  const name = safeText(value.name, MAX_NAME_LENGTH);
  const symbol = safeText(
    typeof value.nativeCurrency === "object" && value.nativeCurrency !== null
      ? (value.nativeCurrency as Record<string, unknown>).symbol
      : value.nativeSymbol,
    MAX_SYMBOL_LENGTH,
  );
  const currencyName = safeText(
    typeof value.nativeCurrency === "object" && value.nativeCurrency !== null
      ? (value.nativeCurrency as Record<string, unknown>).name
      : value.nativeName,
    MAX_NAME_LENGTH,
  );
  const decimalsValue = typeof value.nativeCurrency === "object" && value.nativeCurrency !== null
    ? (value.nativeCurrency as Record<string, unknown>).decimals
    : value.nativeDecimals;
  const decimals = Number(decimalsValue ?? 18);
  const rpcUrl = typeof value.rpcUrl === "string" ? normalizeRpcUrl(value.rpcUrl) : null;
  if (
    chainId === null
    || !name
    || !symbol
    || !currencyName
    || !Number.isInteger(decimals)
    || decimals < 0
    || decimals > 36
    || !rpcUrl
    || chainId === LITVM_CHAIN_ID
  ) return null;

  const suppliedId = safeText(value.id, 96);
  const id = suppliedId && /^custom-[0-9]+-[0-9a-f]+$/u.test(suppliedId)
    ? suppliedId
    : customNetworkId(chainId, rpcUrl);
  const explorerUrl = typeof value.explorerUrl === "string"
    ? normalizeExplorerUrl(value.explorerUrl)
    : "";
  return {
    id,
    name,
    chainId,
    rpcUrl,
    explorerUrl,
    nativeCurrency: { name: currencyName, symbol, decimals },
    builtin: false,
  };
}

export function normalizeCustomNetworks(value: unknown): WalletNetwork[] {
  if (!Array.isArray(value)) return [];
  const result: WalletNetwork[] = [];
  const ids = new Set<string>();
  const chainIds = new Set<number>([LITVM_CHAIN_ID]);
  for (const entry of value.slice(0, MAX_CUSTOM_NETWORKS)) {
    const network = sanitizeCustomNetwork(entry);
    if (!network || ids.has(network.id) || chainIds.has(network.chainId)) continue;
    ids.add(network.id);
    chainIds.add(network.chainId);
    result.push(network);
  }
  return result;
}

export function resolveNetwork(networkId: unknown, customNetworks: readonly WalletNetwork[]): WalletNetwork {
  if (networkId === LITVM_NETWORK.id) return LITVM_NETWORK;
  return customNetworks.find((network) => network.id === networkId) ?? LITVM_NETWORK;
}

const chainCache = new Map<string, Chain>();

/** Builds a viem chain only after the profile has passed the validator above. */
export function viemChainFor(network: WalletNetwork): Chain {
  if (isLitvmNetwork(network)) return litvm;
  const cached = chainCache.get(network.id);
  if (cached) return cached;
  const chain = defineChain({
    id: network.chainId,
    name: network.name,
    nativeCurrency: network.nativeCurrency,
    rpcUrls: { default: { http: [network.rpcUrl] } },
    ...(network.explorerUrl
      ? { blockExplorers: { default: { name: `${network.name} Explorer`, url: network.explorerUrl } } }
      : {}),
  });
  chainCache.set(network.id, chain);
  return chain;
}
