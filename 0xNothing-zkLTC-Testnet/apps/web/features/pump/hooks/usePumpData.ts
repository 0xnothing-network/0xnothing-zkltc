"use client";

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAccount, usePublicClient } from "wagmi";
import type { Address } from "viem";
import { pumpTokenAbi } from "@/features/pump/abis";
import { LIVE_MS, STEADY_LIVE_MS } from "@/lib/liveData";
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

async function apiJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, { signal, cache: "no-store" });
  const body = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) throw new Error(body.error || `Request failed with HTTP ${response.status}`);
  return body;
}

function normalizeMarketSearch(value: string) {
  return value.normalize("NFKC").trim().toLowerCase();
}

function marketSearchRank(market: PumpMarket, rawSearch: string) {
  const tokens = normalizeMarketSearch(rawSearch)
    .split(/\s+/)
    .map((token) => token.replace(/^\$/, ""))
    .filter(Boolean);
  if (!tokens.length) return 0;

  const name = normalizeMarketSearch(market.name);
  const symbol = normalizeMarketSearch(market.symbol);
  const address = market.tokenAddress.toLowerCase();
  const addressWithoutPrefix = address.startsWith("0x") ? address.slice(2) : address;
  const nameWords = name.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const compactName = nameWords.join("");

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

function activeTradeTime(market: PumpMarket) {
  return market.tradeCount > 0 ? market.lastTradeAt : 0;
}

function compareMarkets(left: PumpMarket, right: PumpMarket, sort: PumpMarketSort) {
  if (sort === "VOLUME") {
    const leftVolume = safeMarketBigInt(left.volumeNusd);
    const rightVolume = safeMarketBigInt(right.volumeNusd);
    if (leftVolume !== rightVolume) return leftVolume > rightVolume ? -1 : 1;
    const leftTrade = activeTradeTime(left);
    const rightTrade = activeTradeTime(right);
    if (leftTrade !== rightTrade) return rightTrade - leftTrade;
  }
  if (sort === "LAST_TRADE") {
    const leftTrade = activeTradeTime(left);
    const rightTrade = activeTradeTime(right);
    if (leftTrade !== rightTrade) return rightTrade - leftTrade;
  }
  if (left.createdAt !== right.createdAt) return right.createdAt - left.createdAt;
  return left.tokenAddress.toLowerCase().localeCompare(right.tokenAddress.toLowerCase());
}

export function usePumpMarkets(options?: {
  limit?: number;
  search?: string;
  status?: PumpStatus | "ALL";
  sort?: PumpMarketSort;
}) {
  const limit = options?.limit ?? 100;
  const sort = options?.sort ?? "NEWEST";
  const query = useQuery({
    queryKey: ["pump-markets", limit, sort],
    queryFn: ({ signal }) =>
      apiJson<PumpListResponse>(`/api/pump/markets?limit=${limit}&sort=${sort}`, signal),
    staleTime: 4_000,
    refetchInterval: LIVE_MS,
  });

  const markets = useMemo(() => {
    const search = options?.search ?? "";
    const status = options?.status ?? "ALL";
    return (query.data?.markets ?? [])
      .map((market) => ({ market, searchRank: marketSearchRank(market, search) }))
      .filter(({ market, searchRank }) =>
        searchRank >= 0 && (status === "ALL" || market.status === status))
      .sort((left, right) =>
        left.searchRank - right.searchRank || compareMarkets(left.market, right.market, sort))
      .map(({ market }) => market);
  }, [options?.search, options?.status, query.data?.markets, sort]);

  return { ...query, markets };
}

export function usePumpStats() {
  return useQuery({
    queryKey: ["pump-stats"],
    queryFn: ({ signal }) => apiJson<PumpStatsResponse>("/api/pump/stats", signal),
    staleTime: 4_000,
    refetchInterval: LIVE_MS,
  });
}

export function usePumpMarket(token: Address | undefined) {
  return useQuery({
    queryKey: ["pump-market", token],
    queryFn: ({ signal }) =>
      apiJson<PumpMarketResponse>(`/api/pump/markets/${token}`, signal),
    enabled: Boolean(token),
    staleTime: 4_000,
    refetchInterval: LIVE_MS,
    refetchIntervalInBackground: false,
  });
}

export function usePumpTrades(token: Address | undefined, limit = 40) {
  const params = new URLSearchParams({ limit: limit.toString() });
  if (token) params.set("token", token);
  return useQuery({
    queryKey: ["pump-trades", token, limit],
    queryFn: ({ signal }) =>
      apiJson<PumpTradesResponse>(`/api/pump/trades?${params.toString()}`, signal),
    enabled: Boolean(token),
    staleTime: 0,
    refetchInterval: 2_000,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
  });
}

export function usePumpHolders(token: Address | undefined, limit = 10) {
  const params = new URLSearchParams({ limit: limit.toString() });
  if (token) params.set("token", token);
  return useQuery({
    queryKey: ["pump-holders", token, limit],
    queryFn: ({ signal }) =>
      apiJson<PumpHoldersResponse>(`/api/pump/holders?${params.toString()}`, signal),
    enabled: Boolean(token),
    staleTime: 6_000,
    refetchInterval: 8_000,
  });
}

export function usePumpCandles(
  token: Address | undefined,
  period: PumpCandlePeriod = DEFAULT_PUMP_CANDLE_PERIOD,
) {
  const limit = PUMP_CANDLE_LIMITS[period];
  return useQuery({
    queryKey: ["pump-candles", token, period, limit],
    queryFn: ({ signal }) =>
      apiJson<PumpCandlesResponse>(
        `/api/pump/candles?token=${token}&period=${period}&limit=${limit}`,
        signal,
    ),
    enabled: Boolean(token),
    staleTime: 0,
    refetchInterval: (query) => query.state.data?.source === "rpc" ? 6_000 : 3_000,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
  });
}

export function usePumpPortfolio() {
  const { address } = useAccount();
  const publicClient = usePublicClient();
  const marketsQuery = useQuery({
    queryKey: ["pump-portfolio-markets"],
    queryFn: ({ signal }) => fetchAllMarkets(undefined, signal),
    enabled: Boolean(address),
    staleTime: 8_000,
    refetchInterval: STEADY_LIVE_MS,
  });
  const createdQuery = useQuery({
    queryKey: ["pump-portfolio-created", address],
    queryFn: ({ signal }) => fetchAllMarkets(address, signal),
    enabled: Boolean(address),
    staleTime: 8_000,
    refetchInterval: STEADY_LIVE_MS,
  });
  const markets = marketsQuery.data?.markets ?? EMPTY_MARKETS;
  const tokensKey = useMemo(
    () => markets.map((market) => market.tokenAddress.toLowerCase()).join(","),
    [markets],
  );

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
    staleTime: 4_000,
    refetchInterval: LIVE_MS,
  });

  const created = createdQuery.data?.markets ?? [];
  const balances = balancesQuery.data?.balances ?? EMPTY_BALANCES;
  const held = useMemo(
    () => markets.filter(
      (market) => (balances.get(market.tokenAddress.toLowerCase()) ?? 0n) > 0n,
    ),
    [balances, markets],
  );
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
    refetchHeld: () => {
      void marketsQuery.refetch();
      void balancesQuery.refetch();
    },
    refetchCreated: () => void createdQuery.refetch(),
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
