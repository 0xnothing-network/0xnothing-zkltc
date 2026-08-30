import { type Address, isAddress } from "viem";
import { erc20Abi, tokenImageAbi } from "../../abis";
import {
  BUILTIN_TOKENS,
  customToken,
  nativeTokenFor,
  type WalletToken,
} from "../../config/assets";
import { LITVM_NETWORK, type WalletNetwork } from "../../config/networks";
import { t } from "../i18n";
import { persistentStore } from "../platform/storage";
import { STORAGE_KEYS } from "../platform/storageKeys";
import { withNamedLock } from "../platform/locks";
import { activeNetwork, publicClient } from "../rpc/client";

/**
 * The asset list: the built-ins plus whatever the user imported by address.
 *
 * An import is verified on chain before it is stored — `symbol`, `name` and
 * `decimals` are read from the contract, never typed in — so a token cannot be
 * listed under a symbol it does not actually have. Imported entries are priced
 * from their 0xPump curve or NUSD pool, which is why `customToken` marks them
 * "pool".
 */
interface StoredToken {
  address: Address;
  symbol: string;
  name: string;
  decimals: number;
  /** Optional imageURI() returned by a 0xPump token. */
  logo?: string;
  /** Imported tokens stay isolated when the user switches networks. */
  networkId?: string;
}

export interface TokenMetadata {
  symbol: string;
  name: string;
  decimals: number;
  logo?: string;
}

const BUILTIN_IDS = new Set(BUILTIN_TOKENS.map((token) => token.id));
const TOKENS_LOCK = `tokens:${STORAGE_KEYS.tokens}`;
const METADATA_TTL_MS = 5 * 60_000;
const MAX_STORED_TOKENS = 256;
const MAX_SYMBOL_LENGTH = 16;
const MAX_NAME_LENGTH = 80;
const MAX_LOGO_LENGTH = 2_048;
const metadataCache = new Map<string, { value: TokenMetadata; expiresAt: number }>();
const metadataInFlight = new Map<string, Promise<TokenMetadata>>();

function cleanText(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0
    && trimmed.length <= max
    && !/[\u0000-\u001f\u007f]/u.test(trimmed)
    ? trimmed
    : null;
}

function storedToken(value: unknown): StoredToken | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const entry = value as Record<string, unknown>;
  const symbol = cleanText(entry.symbol, MAX_SYMBOL_LENGTH);
  const name = cleanText(entry.name, MAX_NAME_LENGTH);
  const decimals = Number(entry.decimals);
  const address = entry.address;
  const networkId = entry.networkId === undefined ? undefined : cleanText(entry.networkId, 96);
  const logo = typeof entry.logo === "string"
    && entry.logo.trim().length > 0
    && entry.logo.trim().length <= MAX_LOGO_LENGTH
    ? entry.logo.trim()
    : undefined;
  if (
    typeof address !== "string"
    || !isAddress(address)
    || symbol === null
    || name === null
    || !Number.isInteger(decimals)
    || decimals < 0
    || decimals > 36
    || (entry.networkId !== undefined && networkId === null)
  ) return null;
  return {
    address,
    symbol,
    name,
    decimals,
    logo,
    networkId: networkId ?? undefined,
  };
}

async function readStored(): Promise<StoredToken[]> {
  const raw = await persistentStore.get<unknown>(STORAGE_KEYS.tokens);
  if (!Array.isArray(raw)) return [];
  const result: StoredToken[] = [];
  const seen = new Set<string>();
  for (const value of raw.slice(-MAX_STORED_TOKENS).reverse()) {
    const token = storedToken(value);
    if (!token) continue;
    const key = `${token.networkId ?? LITVM_NETWORK.id}:${token.address.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(token);
  }
  return result.reverse();
}

export async function listTokens(network: WalletNetwork = activeNetwork): Promise<WalletToken[]> {
  const stored = await readStored();
  return [
    ...(network.builtin ? BUILTIN_TOKENS : [nativeTokenFor(network)]),
    ...stored
      .filter((entry) => !BUILTIN_IDS.has(entry.address.toLowerCase()))
      .filter((entry) => (entry.networkId ?? LITVM_NETWORK.id) === network.id)
      .map((entry) => customToken(entry)),
  ];
}

/** Reads ERC-20 metadata and the optional 0xPump image URI in one batch. */
async function readTokenMetadata(
  token: Address,
  network: WalletNetwork,
  client: typeof publicClient,
): Promise<TokenMetadata> {
  let symbol = "";
  let name = "";
  let decimals = -1;
  let logoValue: unknown;
  if (network.builtin) {
    const calls = await client.multicall({
      allowFailure: true,
      contracts: [
        { address: token, abi: erc20Abi, functionName: "symbol" },
        { address: token, abi: erc20Abi, functionName: "name" },
        { address: token, abi: erc20Abi, functionName: "decimals" },
        { address: token, abi: tokenImageAbi, functionName: "imageURI" },
      ] as const,
    });
    symbol = calls[0]?.status === "success" ? (calls[0].result as string) : "";
    name = calls[1]?.status === "success" ? (calls[1].result as string) : "";
    decimals = calls[2]?.status === "success" ? Number(calls[2].result) : -1;
    logoValue = calls[3]?.status === "success" ? calls[3].result : undefined;
  } else {
    // A custom chain may not have Multicall3 deployed. Independent reads keep
    // ERC-20 import usable without assuming a contract at a canonical address.
    const [symbolResult, nameResult, decimalsResult, logoResult] = await Promise.all([
      readOne(() => client.readContract({ address: token, abi: erc20Abi, functionName: "symbol" })),
      readOne(() => client.readContract({ address: token, abi: erc20Abi, functionName: "name" })),
      readOne(() => client.readContract({ address: token, abi: erc20Abi, functionName: "decimals" })),
      readOne(() => client.readContract({ address: token, abi: tokenImageAbi, functionName: "imageURI" })),
    ]);
    symbol = typeof symbolResult === "string" ? symbolResult : "";
    name = typeof nameResult === "string" ? nameResult : "";
    decimals = typeof decimalsResult === "number" ? decimalsResult : -1;
    logoValue = logoResult;
  }
  const cleanSymbol = cleanText(symbol, MAX_SYMBOL_LENGTH);
  const cleanName = cleanText(name, MAX_NAME_LENGTH) ?? cleanSymbol;
  if (
    cleanSymbol === null
    || cleanName === null
    || !Number.isInteger(decimals)
    || decimals < 0
    || decimals > 36
  ) {
    throw new Error(t("err.tokenUnreadable"));
  }
  const logo = typeof logoValue === "string" && logoValue.trim().length <= MAX_LOGO_LENGTH
    ? logoValue.trim() || undefined
    : undefined;
  return { symbol: cleanSymbol, name: cleanName, decimals, logo };
}

async function readOne<T>(run: () => Promise<T>): Promise<T | undefined> {
  try {
    return await run();
  } catch {
    return undefined;
  }
}

/**
 * Token previews and the subsequent Add action ask for the same immutable-ish
 * metadata back-to-back. Coalesce those reads and keep a short positive cache;
 * failures are never cached, so a temporarily unhealthy RPC recovers at once.
 */
export async function lookupToken(
  address: string,
  network: WalletNetwork = activeNetwork,
  client: typeof publicClient = publicClient,
): Promise<TokenMetadata> {
  const trimmed = address.trim();
  if (!isAddress(trimmed)) throw new Error(t("err.badAddress"));
  const token = trimmed as Address;
  const key = `${network.id}:${network.rpcUrl}:${token.toLowerCase()}`;
  const cached = metadataCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  if (cached) metadataCache.delete(key);

  const running = metadataInFlight.get(key);
  if (running) return running;

  const request = readTokenMetadata(token, network, client)
    .then((value) => {
      metadataCache.set(key, { value, expiresAt: Date.now() + METADATA_TTL_MS });
      return value;
    })
    .finally(() => {
      metadataInFlight.delete(key);
    });
  metadataInFlight.set(key, request);
  return request;
}

export async function addCustomToken(
  address: string,
  network: WalletNetwork = activeNetwork,
): Promise<WalletToken[]> {
  const trimmed = address.trim();
  if (!isAddress(trimmed)) throw new Error(t("err.badAddress"));
  const token = trimmed as Address;
  const id = token.toLowerCase();
  if (BUILTIN_IDS.has(id)) throw new Error(t("err.tokenBuiltin"));
  const meta = await lookupToken(token, network);
  return withNamedLock(TOKENS_LOCK, async () => {
    const stored = await readStored();
    if (stored.some(
      (entry) => entry.address.toLowerCase() === id
        && (entry.networkId ?? LITVM_NETWORK.id) === network.id,
    )) {
      throw new Error(t("err.tokenAdded"));
    }
    await persistentStore.set(STORAGE_KEYS.tokens, [
      ...stored,
      { address: token, ...meta, networkId: network.id },
    ].slice(-MAX_STORED_TOKENS));
    return listTokens(network);
  });
}

export async function removeCustomToken(
  id: string,
  network: WalletNetwork = activeNetwork,
): Promise<WalletToken[]> {
  return withNamedLock(TOKENS_LOCK, async () => {
    const stored = await readStored();
    await persistentStore.set(
      STORAGE_KEYS.tokens,
      stored.filter(
        (entry) => entry.address.toLowerCase() !== id.toLowerCase()
          || (entry.networkId ?? LITVM_NETWORK.id) !== network.id,
      ),
    );
    return listTokens(network);
  });
}
