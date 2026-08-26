"use client";

import { zeroAddress, type Address } from "viem";
import { useReadContract, useReadContracts } from "wagmi";
import { dexFactoryAbi, dexPoolAbi, dexRouterAbi } from "@fi/lib/abis/dex";

export type SwapRouteKind = "oracle" | "direct" | "via-nusd" | "checking" | "unavailable";
export type SwapPath = readonly Address[];
const SWAP_QUOTE_REFRESH_MS = 7_000;

function validPair(value: Address | undefined): Address | undefined {
  return value && value.toLowerCase() !== zeroAddress ? value : undefined;
}

function hasLiveLiquidity(data: unknown): boolean {
  const results = data as readonly [{ result?: unknown }, { result?: unknown }] | undefined;
  const reserves = results?.[0]?.result as readonly [bigint, bigint, number] | undefined;
  const totalSupply = results?.[1]?.result as bigint | undefined;
  return Boolean(reserves && reserves[0] > 0n && reserves[1] > 0n && totalSupply && totalSupply > 0n);
}

function finalAmount(amounts: readonly bigint[] | undefined): bigint | undefined {
  return amounts?.at(-1);
}

function unresolved(enabled: boolean, query: {
  data?: unknown;
  error?: unknown;
}): boolean {
  // React Query keeps the last successful snapshot while refreshing. Treat
  // only the first unresolved read as blocking so reserve refreshes cannot
  // make a settled route flash back to a loading state.
  return enabled && query.data === undefined && !query.error;
}

function currentError(enabled: boolean, query: {
  data?: unknown;
  error?: unknown;
}): unknown {
  // A failed background refresh can coexist with a last-known-good snapshot.
  // Keep the stable route and let its executable quote remain the fail-closed gate.
  return enabled && query.data === undefined ? query.error : undefined;
}

function useLivePair({
  enabled,
  factory,
  tokenA,
  tokenB,
}: {
  enabled: boolean;
  factory?: Address;
  tokenA?: Address;
  tokenB?: Address;
}) {
  const pairQuery = useReadContract({
    address: factory,
    abi: dexFactoryAbi,
    functionName: "getPair",
    args: enabled && tokenA && tokenB ? [tokenA, tokenB] : undefined,
    query: {
      enabled,
      staleTime: Infinity,
      // A non-zero pair mapping is immutable. An empty mapping can become a
      // live pair later, so retry only while it is still empty.
      refetchInterval: (query) => validPair(query.state.data as Address | undefined) ? false : 5_000,
    },
  });
  const pair = validPair(pairQuery.data);
  const liquidityQuery = useReadContracts({
    contracts: pair ? [
      { address: pair, abi: dexPoolAbi, functionName: "getReserves" },
      { address: pair, abi: dexPoolAbi, functionName: "totalSupply" },
    ] as const : [],
    query: { enabled: Boolean(pair) },
  });

  return {
    error: currentError(enabled, pairQuery) ?? currentError(Boolean(pair), liquidityQuery),
    live: hasLiveLiquidity(liquidityQuery.data),
    pending: unresolved(enabled, pairQuery) || unresolved(Boolean(pair), liquidityQuery),
  };
}

export function useSwapRoute({
  amountIn,
  bridge,
  factory,
  input,
  isOracleRoute,
  output,
  router,
}: {
  amountIn?: bigint;
  bridge?: Address;
  factory?: Address;
  input?: Address;
  isOracleRoute: boolean;
  output?: Address;
  router?: Address;
}) {
  const distinctTokens = Boolean(input && output && input.toLowerCase() !== output.toLowerCase());
  const canProbe = Boolean(factory && router && distinctTokens && !isOracleRoute);
  const canProbeBridge = Boolean(
    canProbe
    && bridge
    && input
    && output
    && input.toLowerCase() !== bridge.toLowerCase()
    && output.toLowerCase() !== bridge.toLowerCase(),
  );

  const directPair = useLivePair({ enabled: canProbe, factory, tokenA: input, tokenB: output });
  const bridgeInPair = useLivePair({
    enabled: canProbeBridge,
    factory,
    tokenA: input,
    tokenB: bridge,
  });
  const bridgeOutPair = useLivePair({
    enabled: canProbeBridge,
    factory,
    tokenA: bridge,
    tokenB: output,
  });

  const directPath: SwapPath | undefined = directPair.live && input && output
    ? [input, output]
    : undefined;
  const bridgeLive = bridgeInPair.live && bridgeOutPair.live;
  const bridgePath: SwapPath | undefined = bridgeLive && input && bridge && output
    ? [input, bridge, output]
    : undefined;

  const directQuote = useReadContract({
    address: router,
    abi: dexRouterAbi,
    functionName: "getAmountsOut",
    args: directPath && amountIn ? [amountIn, [...directPath]] : undefined,
    query: {
      enabled: Boolean(router && directPath && amountIn),
      refetchInterval: SWAP_QUOTE_REFRESH_MS,
      refetchIntervalInBackground: false,
    },
  });
  const bridgeQuote = useReadContract({
    address: router,
    abi: dexRouterAbi,
    functionName: "getAmountsOut",
    args: bridgePath && amountIn ? [amountIn, [...bridgePath]] : undefined,
    query: {
      enabled: Boolean(router && bridgePath && amountIn),
      refetchInterval: SWAP_QUOTE_REFRESH_MS,
      refetchIntervalInBackground: false,
    },
  });

  if (isOracleRoute) {
    return {
      amountInQuoted: undefined,
      amountOut: undefined,
      bridgeLive: false,
      directLive: false,
      discoverySettled: true,
      error: undefined,
      isFetching: false,
      kind: "oracle" as const,
      path: undefined,
      quotesSettled: true,
    };
  }

  const discoveryPending = directPair.pending || bridgeInPair.pending || bridgeOutPair.pending;
  if (discoveryPending) {
    return {
      amountInQuoted: undefined,
      amountOut: undefined,
      bridgeLive,
      directLive: directPair.live,
      discoverySettled: false,
      error: undefined,
      isFetching: true,
      kind: "checking" as const,
      path: undefined,
      quotesSettled: false,
    };
  }

  const discoveryError = directPair.error ?? bridgeInPair.error ?? bridgeOutPair.error;
  if (!amountIn) {
    const path = directPath ?? bridgePath;
    return {
      amountInQuoted: undefined,
      amountOut: undefined,
      bridgeLive,
      directLive: directPair.live,
      discoverySettled: true,
      error: path ? undefined : discoveryError,
      isFetching: false,
      kind: directPath ? "direct" as const : bridgePath ? "via-nusd" as const : "unavailable" as const,
      path,
      quotesSettled: true,
    };
  }

  const directQuotePending = unresolved(Boolean(directPath), directQuote);
  const bridgeQuotePending = unresolved(Boolean(bridgePath), bridgeQuote);
  if (directQuotePending || bridgeQuotePending) {
    return {
      amountInQuoted: undefined,
      amountOut: undefined,
      bridgeLive,
      directLive: directPair.live,
      discoverySettled: true,
      error: undefined,
      isFetching: true,
      kind: "checking" as const,
      path: undefined,
      quotesSettled: false,
    };
  }

  const directOutput = directQuote.error ? undefined : finalAmount(directQuote.data);
  const bridgeOutput = bridgeQuote.error ? undefined : finalAmount(bridgeQuote.data);
  const useBridge = bridgeOutput !== undefined && (directOutput === undefined || bridgeOutput > directOutput);
  const amountOut = useBridge ? bridgeOutput : directOutput;
  const path = useBridge ? bridgePath : directPath;
  // A cached quote may remain visible during a background refresh, but it is
  // never executable until the selected candidate has settled for this key.
  const candidateQuoteRefreshing = Boolean(
    directPath && directQuote.isFetching
    || bridgePath && bridgeQuote.isFetching,
  );
  const quoteError = amountOut === undefined && (directPath || bridgePath)
    ? directQuote.error ?? bridgeQuote.error ?? new Error("No executable quote is available.")
    : undefined;

  return {
    amountInQuoted: amountOut === undefined || candidateQuoteRefreshing ? undefined : amountIn,
    amountOut,
    bridgeLive,
    directLive: directPair.live,
    discoverySettled: true,
    error: quoteError ?? (amountOut === undefined ? discoveryError : undefined),
    isFetching: false,
    kind: amountOut === undefined ? "unavailable" as const : useBridge ? "via-nusd" as const : "direct" as const,
    path: amountOut === undefined ? undefined : path,
    quotesSettled: true,
  };
}
