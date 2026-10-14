import type { QueryClient, QueryKey } from "@tanstack/react-query";

export const BLOCK_SYNC_MS = 10_000;
export const LIVE_MS = 5_000;
export const STEADY_LIVE_MS = 10_000;
export const FI_LIVE_MS = 15_000;

/**
 * Reads whose result never changes for a deployed contract. Everything else is
 * live state, so a contract function added later is refreshed without being
 * listed here. Solidity constants and immutables are UPPER_CASE by convention.
 */
const IMMUTABLE_CONTRACT_READS = new Set([
  "allPairs",
  "decimals",
  "factory",
  "imageURI",
  "metadataURI",
  "name",
  "nusd",
  "pump",
  "symbol",
  "token0",
  "token1",
  "tokenData",
  "tokenPackedData",
  "tokenURI",
]);
const CONSTANT_READ = /^[A-Z][A-Z0-9_]*$/;

/** App query families refreshed by chain events; artwork and token metadata never change. */
const LIVE_APP_QUERY_PREFIXES = ["pump-", "pixel-", "fi-", "rwa-"] as const;
const STATIC_APP_QUERIES = new Set(["pump-token-metadata", "pixel-nusd-artwork"]);

function readFunctionName(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const functionName = (value as { functionName?: unknown }).functionName;
  return typeof functionName === "string" ? functionName : undefined;
}

function isLiveRead(value: unknown): boolean {
  const functionName = readFunctionName(value);
  return Boolean(functionName && !IMMUTABLE_CONTRACT_READS.has(functionName) && !CONSTANT_READ.test(functionName));
}

/** Contract reads and balances that a new block may change. */
export function isBlockSyncedQueryKey(queryKey: QueryKey): boolean {
  const prefix = queryKey[0];
  if (prefix === "balance") return true;
  if (prefix === "readContract") return isLiveRead(queryKey[1]);
  if (prefix === "readContracts") {
    const contracts = (queryKey[1] as { contracts?: unknown } | undefined)?.contracts;
    return Array.isArray(contracts) && contracts.some(isLiveRead);
  }
  return false;
}

/** Everything a chain event can change: live contract reads plus the app's indexer-backed queries. */
export function isLiveQueryKey(queryKey: QueryKey): boolean {
  if (isBlockSyncedQueryKey(queryKey)) return true;
  const prefix = queryKey[0];
  return typeof prefix === "string"
    && !STATIC_APP_QUERIES.has(prefix)
    && LIVE_APP_QUERY_PREFIXES.some((family) => prefix.startsWith(family));
}

let liveSocketConnected = false;

/** Set by LiveSync while the chain event socket is subscribed. */
export function setLiveSocketConnected(connected: boolean): void {
  liveSocketConnected = connected;
}

export function isLiveSocketConnected(): boolean {
  return liveSocketConnected;
}

/**
 * Polling is the fallback while chain events arrive over the socket: intervals
 * stretch by `connectedFactor` when the socket is up and return to `baseInterval`
 * the moment it drops.
 */
export function livePollInterval(baseInterval: number, connectedFactor: number): number {
  return liveSocketConnected ? baseInterval * connectedFactor : baseInterval;
}

export async function invalidateAfterPumpTrade(queryClient: QueryClient, token: string): Promise<void> {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: ["pump-market", token] }),
    queryClient.invalidateQueries({ queryKey: ["pump-trades", token] }),
    queryClient.invalidateQueries({ queryKey: ["pump-candles", token] }),
    queryClient.invalidateQueries({ queryKey: ["pump-holders", token] }),
    queryClient.invalidateQueries({ queryKey: ["pump-markets"] }),
    queryClient.invalidateQueries({ queryKey: ["pump-stats"] }),
    queryClient.invalidateQueries({
      predicate: (query) => {
        const prefix = query.queryKey[0];
        return typeof prefix === "string" && prefix.startsWith("pump-portfolio-");
      },
    }),
  ]);
}
