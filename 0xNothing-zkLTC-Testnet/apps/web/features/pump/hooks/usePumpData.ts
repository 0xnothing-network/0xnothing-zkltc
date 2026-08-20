"use client";

import { useCallback, useDeferredValue, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAccount, usePublicClient } from "wagmi";
import { getAddress, isAddress, type Address } from "viem";
import { pumpTokenAbi } from "@/features/pump/abis";
import { fetchJson } from "@/lib/http";
import { STEADY_LIVE_MS } from "@/lib/liveData";
import {
  pumpPollInterval,
  usePumpVisibilityRefresh,
} from "@/features/pump/hooks/usePumpPolling";
import {
  DEFAULT_PUMP_CANDLE_PERIOD,
  PUMP_CANDLE_LIMITS,
  type PumpCandlePeriod,
  type PumpCandlesResponse,
  type PumpHoldersResponse,
  type PumpListResponse,
  type PumpMarket,
  type PumpMarketResponse,
  type PumpMarketSort,
  type PumpStatsResponse,
  type PumpStatus,
  type PumpTradesResponse,
} from "@/features/pump/types";

const EMPTY_MARKETS: PumpMarket[] = [];
const EMPTY_BALANCES = new Map<string, bigint>();
const marketCollator = new Intl.Collator("en", { sensitivity: "base" });

type NormalizedMarket = {
  market: PumpMarket;
  normalizedName: string;
  normalizedSymbol: string;
  normalizedAddress: string;
  normalizedAddressNoPrefix: string;
  nameWords: string[];
  compactName: string;
  volumeWad: bigint;
};

const normalizedMarketCache = new WeakMap<PumpMarket, NormalizedMarket>();
function getNormalizedMarket(market: PumpMarket): NormalizedMarket {
  const cached = normalizedMarketCache.get(market);
  if (cached) return cached;
  const rawName = market.name;
  const rawSymbol = market.symbol;
  const rawAddress = market.tokenAddress;
  const normalizedName = normalizeMarketSearch(rawName);
  const normalizedSymbol = normalizeMarketSearch(rawSymbol);
  const normalizedAddress = rawAddress.toLowerCase();
  const normalizedAddressNoPrefix = normalizedAddress.startsWith("0x")
    ? normalizedAddress.slice(2)
    : normalizedAddress;
  const nameWords = normalizedName.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const compactName = nameWords.join("");
  const volumeWad = safeMarketBigInt(market.volumeNusd);
  const normalized: NormalizedMarket = {
    market,
    normalizedName,
    normalizedSymbol,
    normalizedAddress,
    normalizedAddressNoPrefix,
    nameWords,
    compactName,
    volumeWad,
  };
  normalizedMarketCache.set(market, normalized);
  return normalized;
}

async function apiJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  return fetchJson<T>(url, { signal });
}

function normalizeMarketSearch(value: string) {
  return value.normalize("NFKC").trim().toLowerCase();
}

function marketSearchRank(normalized: NormalizedMarket, tokens: string[]) {
  if (!tokens.length) return 0;

  const name = normalized.normalizedName;
  const symbol = normalized.normalizedSymbol;
  const address = normalized.normalizedAddress;
  const addressWithoutPrefix = normalized.normalizedAddressNoPrefix;
  const nameWords = normalized.nameWords;
  const compactName = normalized.compactName;

  let totalRank = 0;
  for (const token of tokens) {
    const tokenWithoutPrefix = token.startsWith("0x") ? token.slice(2) : token;
    let rank = -1;
    if (
      name === token ||
      symbol === token ||
      address === token ||
      (tokenWithoutPrefix && addressWithoutPrefix === tokenWithoutPrefix)
    ) {
      rank = 0;
    } else if (
      name.startsWith(token) ||
      symbol.startsWith(token) ||
      compactName.startsWith(token) ||
      address.startsWith(token) ||
      (tokenWithoutPrefix && addressWithoutPrefix.startsWith(tokenWithoutPrefix))
    ) {
      rank = 1;
    } else if (nameWords.some((word) => word.startsWith(token))) {
      rank = 2;
    } else if (
      name.includes(token) ||
      symbol.includes(token) ||
      address.includes(token) ||
      (tokenWithoutPrefix && addressWithoutPrefix.includes(tokenWithoutPrefix))
    ) {
      rank = 3;
    }
    if (rank < 0) return -1;
    totalRank += rank;
  }
  return totalRank;
}

function safeMarketBigInt(value: string) {
  return /^\d+$/.test(value) ? BigInt(value) : 0n;
}

function compareMarkets(left: NormalizedMarket, right: NormalizedMarket, sort: PumpMarketSort) {
  if (sort === "VOLUME") {
    const leftVolume = left.volumeWad;
    const rightVolume = right.volumeWad;
    if (leftVolume !== rightVolume) return leftVolume > rightVolume ? -1 : 1;
  }
  const leftTrade = left.market.tradeCount > 0 ? left.market.lastTradeAt : 0;
  const rightTrade = right.market.tradeCount > 0 ? right.market.lastTradeAt : 0;
  if (sort === "VOLUME" || sort === "LAST_TRADE") {
    if (leftTrade !== rightTrade) return rightTrade - leftTrade;
  }
  if (left.market.createdAt !== right.market.createdAt) return right.market.createdAt - left.market.createdAt;
  return marketCollator.compare(left.market.tokenAddress.toLowerCase(), right.market.tokenAddress.toLowerCase());
}

export function usePumpMarkets(options?: {
  limit?: number;
  search?: string;
  status?: PumpStatus | "ALL";
  sort?: PumpMarketSort;
}) {
  const limit = options?.limit ?? 100;
  const sort = options?.sort ?? "NEWEST";
  const deferredSearch = useDeferredValue(options?.search ?? "");
  const deferredStatus = useDeferredValue(options?.status ?? "ALL");
  const searchForAddress = options?.search ?? "";
  const exactAddress = useMemo(() => {
    const search = normalizeMarketSearch(searchForAddress);
    return isAddress(search) ? getAddress(search) : undefined;
  }, [searchForAddress]);
  const feedKey = `pump-markets:${limit}:${sort}`;
  const query = useQuery({
    queryKey: ["pump-markets", limit, sort],
    queryFn: ({ signal }) =>
      apiJson<PumpListResponse>(`/api/pump/markets?limit=${limit}&sort=${sort}`, signal),
    staleTime: 8_000,
    gcTime: 10 * 60 * 1000,
    refetchInterval: pumpPollInterval(feedKey),
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: true,
    placeholderData: (prev) => prev,
  });
  usePumpVisibilityRefresh({
    key: feedKey,
    dataUpdatedAt: query.dataUpdatedAt,
    isFetching: query.isFetching,
    refetch: query.refetch,
  });
  const searchKey = exactAddress ? `pump-market-search:${exactAddress}` : "";
  const exactMarketQuery = useQuery({
    queryKey: ["pump-market-search", exactAddress],
    queryFn: ({ signal }) =>
      apiJson<PumpMarketResponse>(`/api/pump/markets/${exactAddress}`, signal),
    enabled: Boolean(exactAddress),
    staleTime: 8_000,
    gcTime: 10 * 60 * 1000,
    refetchInterval: exactAddress ? pumpPollInterval(searchKey) : false,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: false,
  });
  usePumpVisibilityRefresh({
    key: searchKey || "pump-market-search:empty",
    dataUpdatedAt: exactMarketQuery.dataUpdatedAt,
    enabled: Boolean(exactAddress),
    isFetching: exactMarketQuery.isFetching,
    refetch: exactMarketQuery.refetch,
  });
  const markets = useMemo(() => {
    const tokens = normalizeMarketSearch(deferredSearch)
      .split(/\s+/)
      .map((token) => token.replace(/^\$/, ""))
      .filter(Boolean);
    const candidates = new Map(
      (query.data?.markets ?? []).map((market) => [market.tokenAddress.toLowerCase(), market]),
    );
    const exactMarket = exactMarketQuery.data?.market;
    if (exactMarket) candidates.set(exactMarket.tokenAddress.toLowerCase(), exactMarket);
    return [...candidates.values()]
      .map((market) => {
        const normalized = getNormalizedMarket(market);
        return { normalized, searchRank: marketSearchRank(normalized, tokens) };
      })
      .filter(({ normalized, searchRank }) =>
        searchRank >= 0 && (deferredStatus === "ALL" || normalized.market.status === deferredStatus))
      .sort((left, right) =>
        left.searchRank - right.searchRank || compareMarkets(left.normalized, right.normalized, sort))
      .map(({ normalized }) => normalized.market);
  }, [deferredSearch, deferredStatus, exactMarketQuery.data?.market, query.data?.markets, sort]);

  const refetchQuery = query.refetch;
  const refetchExact = exactMarketQuery.refetch;
  const refetch = useCallback(async () => {
    const [result] = await Promise.all([
      refetchQuery(),
      exactAddress ? refetchExact() : Promise.resolve(undefined),
    ]);
    return result;
  }, [exactAddress, refetchExact, refetchQuery]);

  return {
    ...query,
    error: query.error ?? (exactAddress ? exactMarketQuery.error : null),
    isError: query.isError || Boolean(exactAddress && exactMarketQuery.isError),
    isLoading: query.isLoading || Boolean(exactAddress && exactMarketQuery.isLoading),
    isFetching: query.isFetching || exactMarketQuery.isFetching,
    refetch,
    markets,
  };
}

export function usePumpStats() {
  const query = useQuery({
    queryKey: ["pump-stats"],
    queryFn: ({ signal }) => apiJson<PumpStatsResponse>("/api/pump/stats", signal),
    staleTime: 10_000,
    gcTime: 10 * 60 * 1000,
    refetchInterval: pumpPollInterval("pump-stats", STEADY_LIVE_MS),
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: false,
  });
  usePumpVisibilityRefresh({
    key: "pump-stats",
    dataUpdatedAt: query.dataUpdatedAt,
    isFetching: query.isFetching,
    refetch: query.refetch,
    maxAgeMs: STEADY_LIVE_MS,
  });
  return query;
}

export function usePumpMarket(token: Address | undefined) {
  const key = token ? `pump-market:${token.toLowerCase()}` : "pump-market:empty";
  const query = useQuery({
    queryKey: ["pump-market", token],
    queryFn: ({ signal }) =>
      apiJson<PumpMarketResponse>(`/api/pump/markets/${token}`, signal),
    enabled: Boolean(token),
    staleTime: 8_000,
    gcTime: 10 * 60 * 1000,
    refetchInterval: pumpPollInterval(key),
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: false,
  });
  usePumpVisibilityRefresh({
    key,
    dataUpdatedAt: query.dataUpdatedAt,
    enabled: Boolean(token),
    isFetching: query.isFetching,
    refetch: query.refetch,
  });
  return query;
}

export function usePumpTrades(token: Address | undefined, limit = 40) {
  const enabled = Boolean(token);
  const params = new URLSearchParams({ limit: limit.toString() });
  if (token) params.set("token", token);
  const key = token ? `pump-trades:${token.toLowerCase()}:${limit}` : `pump-trades:empty:${limit}`;
  const query = useQuery({
    queryKey: ["pump-trades", token, limit],
    queryFn: ({ signal }) =>
      apiJson<PumpTradesResponse>(`/api/pump/trades?${params.toString()}`, signal),
    enabled,
    staleTime: 4_000,
    gcTime: 5 * 60 * 1000,
    refetchInterval: enabled ? pumpPollInterval(key, 4_000) : false,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: false,
    placeholderData: (prev) => prev,
  });
  usePumpVisibilityRefresh({
    key,
    dataUpdatedAt: query.dataUpdatedAt,
    enabled,
    isFetching: query.isFetching,
    refetch: query.refetch,
    maxAgeMs: 4_000,
  });
  return query;
}

export function usePumpHolders(token: Address | undefined, limit = 10) {
  const enabled = Boolean(token);
  const params = new URLSearchParams({ limit: limit.toString() });
  if (token) params.set("token", token);
  const key = token ? `pump-holders:${token.toLowerCase()}:${limit}` : `pump-holders:empty:${limit}`;
  const query = useQuery({
    queryKey: ["pump-holders", token, limit],
    queryFn: ({ signal }) =>
      apiJson<PumpHoldersResponse>(`/api/pump/holders?${params.toString()}`, signal),
    enabled,
    staleTime: 10_000,
    gcTime: 10 * 60 * 1000,
    refetchInterval: enabled ? pumpPollInterval(key, STEADY_LIVE_MS) : false,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: false,
  });
  usePumpVisibilityRefresh({
    key,
    dataUpdatedAt: query.dataUpdatedAt,
    enabled,
    isFetching: query.isFetching,
    refetch: query.refetch,
    maxAgeMs: STEADY_LIVE_MS,
  });
  return query;
}

export function usePumpCandles(
  token: Address | undefined,
  period: PumpCandlePeriod = DEFAULT_PUMP_CANDLE_PERIOD,
) {
  const enabled = Boolean(token);
  const limit = PUMP_CANDLE_LIMITS[period];
  const key = token ? `pump-candles:${token.toLowerCase()}:${period}` : `pump-candles:empty:${period}`;
  const query = useQuery({
    queryKey: ["pump-candles", token, period, limit],
    queryFn: ({ signal }) =>
      apiJson<PumpCandlesResponse>(
        `/api/pump/candles?token=${token}&period=${period}&limit=${limit}`,
        signal,
    ),
    enabled,
    staleTime: 4_000,
    gcTime: 10 * 60 * 1000,
    refetchInterval: enabled ? (q) => {
      const src = (q.state.data as PumpCandlesResponse | undefined)?.source;
      return pumpPollInterval(key, src === "rpc" ? 6_000 : 5_000);
    } : false,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: false,
    placeholderData: (prev) => prev,
  });
  usePumpVisibilityRefresh({
    key,
    dataUpdatedAt: query.dataUpdatedAt,
    enabled,
    isFetching: query.isFetching,
    refetch: query.refetch,
    maxAgeMs: 5_000,
  });
  return query;
}

export function usePumpPortfolio() {
  const { address } = useAccount();
  const publicClient = usePublicClient();
  const marketsQuery = useQuery({
    queryKey: ["pump-portfolio-markets"],
    queryFn: ({ signal }) => fetchAllMarkets(undefined, signal),
    enabled: Boolean(address),
    staleTime: 10_000,
    gcTime: 10 * 60 * 1000,
    refetchInterval: pumpPollInterval("pump-portfolio:markets", STEADY_LIVE_MS),
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: false,
    placeholderData: (prev) => prev,
  });
  usePumpVisibilityRefresh({
    key: "pump-portfolio:markets",
    dataUpdatedAt: marketsQuery.dataUpdatedAt,
    enabled: Boolean(address),
    isFetching: marketsQuery.isFetching,
    refetch: marketsQuery.refetch,
    maxAgeMs: STEADY_LIVE_MS,
  });
  const createdQuery = useQuery({
    queryKey: ["pump-portfolio-created", address],
    queryFn: ({ signal }) => fetchAllMarkets(address, signal),
    enabled: Boolean(address),
    staleTime: 10_000,
    gcTime: 10 * 60 * 1000,
    refetchInterval: address ? pumpPollInterval(`pump-portfolio:created:${address.toLowerCase()}`, STEADY_LIVE_MS) : false,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: false,
    placeholderData: (prev) => prev,
  });
  usePumpVisibilityRefresh({
    key: address ? `pump-portfolio:created:${address.toLowerCase()}` : "pump-portfolio:created:empty",
    dataUpdatedAt: createdQuery.dataUpdatedAt,
    enabled: Boolean(address),
    isFetching: createdQuery.isFetching,
    refetch: createdQuery.refetch,
    maxAgeMs: STEADY_LIVE_MS,
  });
  const markets = marketsQuery.data?.markets ?? EMPTY_MARKETS;
  const marketsHash = useMemo(() => {
    if (!markets.length) return "";
    let hash = 0;
    for (const m of markets) {
      const s = m.tokenAddress.toLowerCase();
      for (let i = 0; i < s.length; i++) hash = ((hash << 5) - hash + s.charCodeAt(i)) | 0;
    }
    return `${markets.length}:${hash >>> 0}`;
  }, [markets]);
  const tokensKey = marketsHash;

  const balancesKey = address ? `pump-portfolio:balances:${address.toLowerCase()}:${tokensKey || "empty"}` : "pump-portfolio:balances:empty";
  const balancesQuery = useQuery({
    queryKey: ["pump-portfolio-balances", address, tokensKey],
    enabled: Boolean(address && publicClient && markets.length),
    queryFn: async () => {
      if (!address || !publicClient) return { balances: new Map<string, bigint>(), failed: 0 };
      const balances = new Map<string, bigint>();
      let failed = 0;
      for (let start = 0; start < markets.length; start += 100) {
        const page = markets.slice(start, start + 100);
        let results = await publicClient.multicall({
          allowFailure: true,
          contracts: page.map((market) => ({
            address: market.tokenAddress,
            abi: pumpTokenAbi,
            functionName: "balanceOf" as const,
            args: [address] as const,
          })),
        });
        const retryMarkets = page.filter((_, index) => results[index].status !== "success");
        if (retryMarkets.length) {
          const retries = await publicClient.multicall({
            allowFailure: true,
            contracts: retryMarkets.map((market) => ({
              address: market.tokenAddress,
              abi: pumpTokenAbi,
              functionName: "balanceOf" as const,
              args: [address] as const,
            })),
          });
          let retryIndex = 0;
          results = results.map((result) =>
            result.status === "success" ? result : retries[retryIndex++]);
        }
        results.forEach((result, index) => {
          if (result.status === "success") {
            balances.set(page[index].tokenAddress.toLowerCase(), result.result as bigint);
          } else {
            failed += 1;
          }
        });
      }
      return { balances, failed };
    },
    staleTime: 8_000,
    gcTime: 10 * 60 * 1000,
    refetchInterval: pumpPollInterval(balancesKey, STEADY_LIVE_MS),
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: false,
    placeholderData: (prev) => prev,
  });
  usePumpVisibilityRefresh({
    key: balancesKey,
    dataUpdatedAt: balancesQuery.dataUpdatedAt,
    isFetching: balancesQuery.isFetching,
    refetch: balancesQuery.refetch,
    maxAgeMs: STEADY_LIVE_MS,
  });

  const created = createdQuery.data?.markets ?? [];
  const balances = balancesQuery.data?.balances ?? EMPTY_BALANCES;
  const held = useMemo(
    () => markets.filter(
      (market) => (balances.get(market.tokenAddress.toLowerCase()) ?? 0n) > 0n,
    ),
    [balances, markets],
  );
  const refetchMarkets = marketsQuery.refetch;
  const refetchBalances = balancesQuery.refetch;
  const refetchCreatedQuery = createdQuery.refetch;
  const refetchHeld = useCallback(() => {
    void refetchMarkets();
    void refetchBalances();
  }, [refetchBalances, refetchMarkets]);
  const refetchCreated = useCallback(() => void refetchCreatedQuery(), [refetchCreatedQuery]);

  return {
    address,
    created,
    held,
    balances,
    balanceWarning: balancesQuery.data?.failed
      ? `${balancesQuery.data.failed} token balance${balancesQuery.data.failed === 1 ? "" : "s"} could not be checked.`
      : undefined,
    isLoading: marketsQuery.isLoading || createdQuery.isLoading || balancesQuery.isLoading,
    error: marketsQuery.error || createdQuery.error || balancesQuery.error,
    heldIsLoading: marketsQuery.isLoading || balancesQuery.isLoading,
    createdIsLoading: createdQuery.isLoading,
    heldError: marketsQuery.error || balancesQuery.error,
    createdError: createdQuery.error,
    refetchHeld,
    refetchCreated,
    configured: (marketsQuery.data?.configured ?? true) && (createdQuery.data?.configured ?? true),
  };
}

async function fetchAllMarkets(creator: Address | undefined, signal?: AbortSignal) {
  const pageSize = 200;
  const markets: PumpListResponse["markets"] = [];
  const seen = new Set<string>();
  let configured = true;
  let source: PumpListResponse["source"] = "unconfigured";
  let warning: string | undefined;

  for (let skip = 0; ; skip += pageSize) {
    const params = new URLSearchParams({ limit: pageSize.toString(), skip: skip.toString() });
    if (creator) params.set("creator", creator);
    const page = await apiJson<PumpListResponse>(`/api/pump/markets?${params.toString()}`, signal);
    configured = page.configured;
    source = page.source;
    warning ||= page.warning;
    let added = 0;
    for (const market of page.markets) {
      const key = market.tokenAddress.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      markets.push(market);
      added += 1;
    }
    if (page.markets.length < pageSize || added === 0) break;
  }

  return { markets, configured, source, warning } satisfies PumpListResponse;
}
