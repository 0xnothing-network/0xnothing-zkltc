import { defineChain, type Chain } from "viem";
import {
  LITVM_CHAIN_ID,
  LITVM_EXPLORER_URL,
  LITVM_RPC_URL,
  litvm,
} from "./chain.ts";

const MAX_NAME_LENGTH = 48;
const MAX_SYMBOL_LENGTH = 12;
const MAX_RPC_LENGTH = 2_048;
export const MAX_CUSTOM_NETWORKS = 32;
const MAX_CHAIN_CACHE_ENTRIES = MAX_CUSTOM_NETWORKS * 2;
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
  /** Built-in profiles only: endpoints tried in order when `rpcUrl` fails. */
  fallbackRpcUrls?: readonly string[];
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

export function isLitvmNetwork(network: WalletNetwork): boolean {
  return network.id === LITVM_NETWORK.id;
}

/**
 * Full profile identity for caches and in-flight work. The short persisted id
 * is convenient for settings, but it must not be the only cache boundary for
 * user-controlled network metadata.
 */
export function networkIdentity(network: WalletNetwork): string {
  return JSON.stringify([
    network.id,
    network.chainId,
    network.rpcUrl,
    network.explorerUrl,
    network.name,
    network.nativeCurrency.name,
    network.nativeCurrency.symbol,
    network.nativeCurrency.decimals,
    network.builtin,
  ]);
}

/**
 * The chain a stored row belongs to, from the profile id it was written under.
 * A custom profile's id hashes its RPC URL, so re-adding a chain with a new RPC
 * gives it a new id; tokens and history follow the chain instead, which is
 * unique per wallet (one profile per chainId, and 4441 is LitVM's alone).
 * An id of no known shape stands for itself.
 */
export function chainScope(networkId: string): string {
  if (networkId === LITVM_NETWORK.id) return String(LITVM_NETWORK.chainId);
  return /^custom-(\d+)-/u.exec(networkId)?.[1] ?? networkId;
}

/** Whether a row stored under `storedId` (none: a pre-network LitVM row) belongs to `networkId`'s chain. */
export function onNetworkChain(storedId: string | undefined, networkId: string): boolean {
  return chainScope(storedId ?? LITVM_NETWORK.id) === chainScope(networkId);
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
      || url.hostname.includes("*")
      || url.username
      || url.password
      || url.hash
    ) return null;
    return url.toString();
  } catch {
    return null;
  }
}

/**
 * A plaintext RPC, which `normalizeRpcUrl` allows only on loopback. The
 * extension reaches a developer's local node that way, but the Android shell
 * blocks all cleartext traffic (capacitor `cleartext: false`, targetSdk 36),
 * 127.0.0.1 included, so there the profile would save and then fail every
 * read. The form refuses it when `isAndroid` (core/platform/env); stored
 * profiles are left as they are.
 */
export function cleartextRpcUrl(rpcUrl: string): boolean {
  try {
    return new URL(rpcUrl.trim()).protocol === "http:";
  } catch {
    return false;
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
      || url.hostname.includes("*")
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

  // Persisted settings are untrusted input. Recompute the id so a crafted or
  // stale profile cannot alias another network's cached viem chain.
  const id = customNetworkId(chainId, rpcUrl);
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

/**
 * The user's own RPC for the built-in LiteForge profile, from untrusted stored
 * settings: HTTPS only (no plaintext, loopback included), no credentials or
 * hash, and not the public endpoint itself. Anything else, "" included, means
 * no override, so a bad stored value reads as unset and never throws.
 */
export function litvmRpcOverride(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = normalizeRpcUrl(value);
  if (normalized === null || new URL(normalized).protocol !== "https:") return null;
  return normalized === normalizeRpcUrl(LITVM_RPC_URL) ? null : normalized;
}

const litvmProfiles = new Map<string, WalletNetwork>();

/**
 * LiteForge with the user's endpoint first and the public one as the fallback.
 * Memoized per URL so every read of the same settings gives the same object.
 */
function litvmNetworkWith(rpcUrl: string): WalletNetwork {
  const cached = litvmProfiles.get(rpcUrl);
  if (cached) return cached;
  const network: WalletNetwork = { ...LITVM_NETWORK, rpcUrl, fallbackRpcUrls: [LITVM_RPC_URL] };
  // One override is live at a time; a handful of old ones is all this can hold.
  if (litvmProfiles.size >= 8) litvmProfiles.clear();
  litvmProfiles.set(rpcUrl, network);
  return network;
}

/**
 * `litvmRpcUrl` is the stored override (settings.litvmRpcUrl). Every surface
 * passes it, the worker included: the network identity a dapp request carries
 * holds the RPC URL, so the worker and the approval window must agree on it.
 * Without an override the result is LITVM_NETWORK itself, exactly as before.
 */
export function resolveNetwork(
  networkId: unknown,
  customNetworks: readonly WalletNetwork[],
  litvmRpcUrl?: unknown,
): WalletNetwork {
  const custom = networkId === LITVM_NETWORK.id
    ? undefined
    : customNetworks.find((network) => network.id === networkId);
  if (custom) return custom;
  const override = litvmRpcOverride(litvmRpcUrl);
  return override === null ? LITVM_NETWORK : litvmNetworkWith(override);
}

const chainCache = new Map<string, Chain>();

/** Builds a viem chain only after the profile has passed the validator above. */
export function viemChainFor(network: WalletNetwork): Chain {
  if (isLitvmNetwork(network)) return litvm;
  const cacheKey = networkIdentity(network);
  const cached = chainCache.get(cacheKey);
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
  while (chainCache.size >= MAX_CHAIN_CACHE_ENTRIES) {
    const oldest = chainCache.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    chainCache.delete(oldest);
  }
  chainCache.set(cacheKey, chain);
  return chain;
}
