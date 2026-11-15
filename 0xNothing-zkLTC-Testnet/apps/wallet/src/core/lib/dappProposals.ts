import { normalizeExplorerUrl, normalizeRpcUrl } from "../../config/networks.ts";
import { parseRequestedChainId } from "../../extension/workerRules.ts";
import { foldConfusables, IGNORABLE_LETTERS } from "./confusables.ts";

/**
 * What a page may propose to the wallet: a token to watch (EIP-747) or a network
 * to add (EIP-3085). Both are page text, so every field is checked here, once in
 * the worker before a row is queued and again when the row is read back (the
 * queue lives in storage, which is not trusted either). A value that fails a
 * limit is refused, never trimmed to fit: what the user reviews is what the page
 * sent. Fields the wallet does not use (images, icons) never leave this file.
 */

export interface WatchAsset {
  /** Lower-case: the token list compares addresses that way. */
  address: `0x${string}`;
  /** What the page claimed; shown only where it differs from the contract. */
  symbol?: string;
  decimals?: number;
}

export interface ProposedChain {
  chainId: number;
  name: string;
  currencyName: string;
  symbol: string;
  decimals: number;
  /** Normalized, exactly as it would be saved. */
  rpcUrl: string;
  /** Normalized; "" when the page named none. */
  explorerUrl: string;
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/u;
const ZERO_ADDRESS = `0x${"0".repeat(40)}`;
const CONTROL = /[\u0000-\u001f\u007f]/u;
// Format characters: the bidi marks, embeddings, overrides and isolates (each
// can make a name read in another order than it is stored) and the invisible
// ones (zero-width space and joiners, soft hyphen, word joiner), which hide
// inside a name that then displays exactly as a reserved one.
const FORMAT = /\p{Cf}/u;
const MAX_WATCH_SYMBOL = 11;
const MAX_NETWORK_NAME = 48;
const MAX_CURRENCY_SYMBOL = 12;
const MAX_URLS = 8;
const PRIVATE_SUFFIXES = [".localhost", ".local", ".internal", ".home.arpa", ".lan", ".corp", ".home"];
const RESERVED_NAMES = [foldConfusables("litvm"), foldConfusables("liteforge")];
const RESERVED_SYMBOL = foldConfusables("zkLTC");

function plainObject(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null ? value as Record<string, unknown> : null;
}

/**
 * A clean one-line label: trimmed length 1..max, no control or format
 * characters and no Hangul filler (a letter that displays as a blank gap).
 */
function cleanLabel(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0
    && trimmed.length <= max
    && !CONTROL.test(trimmed)
    && !FORMAT.test(trimmed)
    && !IGNORABLE_LETTERS.test(trimmed)
    ? trimmed
    : null;
}

/** 0..36, as a number or a decimal string (pages send both). */
function cleanDecimals(value: unknown): number | null {
  const number = typeof value === "number"
    ? value
    : typeof value === "string" && /^\d{1,2}$/u.test(value) ? Number(value) : Number.NaN;
  return Number.isInteger(number) && number >= 0 && number <= 36 ? number : null;
}

function cleanAsset(address: unknown, symbol: unknown, decimals: unknown): WatchAsset | string {
  if (typeof address !== "string" || !ADDRESS.test(address) || address.toLowerCase() === ZERO_ADDRESS) {
    return "A token address is required";
  }
  const asset: WatchAsset = { address: address.toLowerCase() as `0x${string}` };
  if (symbol !== undefined) {
    const label = cleanLabel(symbol, MAX_WATCH_SYMBOL);
    if (label === null) return "The token symbol is not valid";
    asset.symbol = label;
  }
  if (decimals !== undefined) {
    const places = cleanDecimals(decimals);
    if (places === null) return "The token decimals are not valid";
    asset.decimals = places;
  }
  return asset;
}

/**
 * wallet_watchAsset's params: `{ type, options }` (EIP-747, viem) or that object
 * as a one-element array (older libraries). `options.chainId` (MetaMask's
 * extension) must name the active network.
 */
export function parseWatchAsset(params: unknown, activeChainId: bigint): { asset: WatchAsset } | { error: string } {
  const p = plainObject(Array.isArray(params) ? (params.length === 1 ? params[0] : undefined) : params);
  if (p === null) return { error: "Invalid watchAsset parameters" };
  if (p.type !== "ERC20") return { error: "Only ERC20 tokens can be added" };
  const options = plainObject(p.options);
  if (options === null) return { error: "Invalid watchAsset parameters" };
  if (options.chainId !== undefined && parseRequestedChainId(options.chainId) !== activeChainId) {
    return { error: "The token's chainId does not match the active network" };
  }
  const asset = cleanAsset(options.address, options.symbol, options.decimals);
  return typeof asset === "string" ? { error: asset } : { asset };
}

/** A stored row's asset, re-checked with the same rules; null when it fails. */
export function safeWatchAsset(value: unknown): WatchAsset | null {
  const entry = plainObject(value);
  if (entry === null) return null;
  const asset = cleanAsset(entry.address, entry.symbol, entry.decimals);
  return typeof asset === "string" || asset.address !== entry.address ? null : asset;
}

/**
 * A host a page may not point the wallet at: loopback, private names, raw IPs.
 * A name with no dot ("https://intranet") only resolves on a local network, and
 * the approval window probes the RPC as soon as it opens.
 */
function privateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/u, "");
  return host === "localhost"
    || !host.includes(".")
    || host.startsWith("[")
    || /^\d+(?:\.\d+){3}$/u.test(host)
    || PRIVATE_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

function publicHttpsRpc(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = normalizeRpcUrl(value);
  if (normalized === null) return null;
  const url = new URL(normalized);
  return url.protocol === "https:" && !privateHost(url.hostname) ? normalized : null;
}

function httpsExplorer(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = normalizeExplorerUrl(value);
  if (normalized === "") return null;
  return new URL(normalized).protocol === "https:" ? normalized : null;
}

/**
 * What a label reads as once look-alike letters are folded and everything but
 * letters and digits is dropped, so "Lite Forge", "Lit-VM" and "zk LTC" read
 * as the reserved names too.
 */
function skeleton(text: string): string {
  return foldConfusables(text).replace(/[^\p{L}\p{N}]/gu, "");
}

function cleanChain(fields: {
  chainId: unknown;
  name: unknown;
  currencyName: unknown;
  symbol: unknown;
  decimals: unknown;
  rpcUrl: unknown;
  explorerUrl: unknown;
}): ProposedChain | string {
  const id = parseRequestedChainId(fields.chainId);
  if (id === null || id > BigInt(Number.MAX_SAFE_INTEGER)) return "A chainId is required";
  const name = cleanLabel(fields.name, MAX_NETWORK_NAME);
  if (name === null) return "The network name is not valid";
  const reservedIn = (text: string) => RESERVED_NAMES.some((reserved) => skeleton(text).includes(reserved));
  if (reservedIn(name)) return "This network name is reserved";
  const currencyName = cleanLabel(fields.currencyName, MAX_NETWORK_NAME);
  const symbol = cleanLabel(fields.symbol, MAX_CURRENCY_SYMBOL);
  const decimals = cleanDecimals(fields.decimals);
  if (currencyName === null || symbol === null || decimals === null) return "The native currency is not valid";
  if (reservedIn(currencyName)) return "This currency name is reserved";
  if (skeleton(symbol) === RESERVED_SYMBOL) return "This currency symbol is reserved";
  const rpcUrl = publicHttpsRpc(fields.rpcUrl);
  if (rpcUrl === null) return "Only a public https RPC URL can be proposed";
  let explorerUrl = "";
  if (fields.explorerUrl !== undefined) {
    const explorer = httpsExplorer(fields.explorerUrl);
    if (explorer === null) return "Only an https block explorer URL can be proposed";
    explorerUrl = explorer;
  }
  return { chainId: Number(id), name, currencyName, symbol, decimals, rpcUrl, explorerUrl };
}

/**
 * wallet_addEthereumChain's params. Only `rpcUrls[0]` is used: the user reviews
 * one URL, and a later entry is never tried behind their back. `iconUrls` and
 * anything else is ignored.
 */
export function parseAddChain(params: unknown): { chain: ProposedChain } | { error: string } {
  const p = plainObject(Array.isArray(params) ? params[0] : undefined);
  if (p === null) return { error: "Invalid addEthereumChain parameters" };
  const currency = plainObject(p.nativeCurrency);
  if (currency === null) return { error: "The native currency is not valid" };
  const rpcUrls = p.rpcUrls;
  if (!Array.isArray(rpcUrls) || rpcUrls.length < 1 || rpcUrls.length > MAX_URLS) {
    return { error: "Only a public https RPC URL can be proposed" };
  }
  const explorers = p.blockExplorerUrls;
  if (explorers !== undefined && explorers !== null && (!Array.isArray(explorers) || explorers.length > MAX_URLS)) {
    return { error: "Only an https block explorer URL can be proposed" };
  }
  const chain = cleanChain({
    chainId: p.chainId,
    name: p.chainName,
    currencyName: currency.name,
    symbol: currency.symbol,
    decimals: currency.decimals,
    rpcUrl: rpcUrls[0],
    explorerUrl: Array.isArray(explorers) && explorers.length > 0 ? explorers[0] : undefined,
  });
  return typeof chain === "string" ? { error: chain } : { chain };
}

/** A stored row's proposal, re-checked with the same rules; null when it fails or was altered. */
export function safeProposedChain(value: unknown): ProposedChain | null {
  const entry = plainObject(value);
  if (entry === null || typeof entry.chainId !== "number") return null;
  const chain = cleanChain({
    ...entry,
    explorerUrl: entry.explorerUrl === "" ? undefined : entry.explorerUrl,
  } as Parameters<typeof cleanChain>[0]);
  if (typeof chain === "string") return null;
  // Normalizing must be a no-op on a stored row: a row that changes here was not
  // written by the worker.
  return chain.rpcUrl === entry.rpcUrl && chain.explorerUrl === (entry.explorerUrl ?? "") ? chain : null;
}
