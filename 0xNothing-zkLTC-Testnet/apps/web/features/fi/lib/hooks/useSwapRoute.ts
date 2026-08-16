"use client";

import { zeroAddress, type Address } from "viem";
import { useReadContract, useReadContracts } from "wagmi";
import { dexFactoryAbi, dexPoolAbi, dexRouterAbi } from "@fi/lib/abis/dex";

export type SwapRouteKind = "oracle" | "direct" | "checking" | "unavailable";
export type SwapPath = readonly [Address, Address];

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
  // only the first unresolved read as blocking so periodic reserve/quote
  // updates do not make the swap card flash back to "Checking liquidity".
  return enabled && query.data === undefined && !query.error;
}

function currentError(enabled: boolean, query: {
  data?: unknown;
  error?: unknown;
}): unknown {
  // A failed background refresh can coexist with a last-known-good snapshot.
  // Keep the stable route and let the executable quote be the fail-closed gate.
  return enabled && query.data === undefined ? query.error : undefined;
}

export function useSwapRoute({
  amountIn,
  factory,
  input,
  isOracleRoute,
  output,
  router,
}: {
  amountIn?: bigint;
  factory?: Address;
  input?: Address;
  isOracleRoute: boolean;
  output?: Address;
  router?: Address;
}) {
  const distinctTokens = Boolean(input && output && input.toLowerCase() !== output.toLowerCase());
  const canProbe = Boolean(factory && router && distinctTokens && !isOracleRoute);

  const directPairQuery = useReadContract({
    address: factory,
    abi: dexFactoryAbi,
    functionName: "getPair",
    args: canProbe && input && output ? [input, output] : undefined,
    // A non-zero pair mapping is immutable, but zero can become a live pair
    // later. Keep probing only while the mapping is still empty so liquidity
    // created in another tab appears without making settled routes flicker.
    query: {
      enabled: canProbe,
      staleTime: Infinity,
      refetchInterval: (query) => validPair(query.state.data as Address | undefined) ? false : 5_000,
    },
  });

  const directPair = validPair(directPairQuery.data);
  const directLiquidity = useReadContracts({
    contracts: directPair ? [
      { address: directPair, abi: dexPoolAbi, functionName: "getReserves" },
      { address: directPair, abi: dexPoolAbi, functionName: "totalSupply" },
    ] as const : [],
    query: { enabled: Boolean(directPair) },
  });

  const pairDiscoveryPending = unresolved(canProbe, directPairQuery);
  const liquidityDiscoveryPending = unresolved(Boolean(directPair), directLiquidity);
  const discoveryPending = pairDiscoveryPending || liquidityDiscoveryPending;

  const directLive = hasLiveLiquidity(directLiquidity.data);
  const directPath: SwapPath | undefined = directLive && input && output ? [input, output] : undefined;

  // Quotes may begin from cached candidate data, but they are never exposed
  // until the direct-pair discovery query above has settled.
  const directQuote = useReadContract({
    address: router,
    abi: dexRouterAbi,
    functionName: "getAmountsOut",
    args: directPath && amountIn ? [amountIn, [...directPath]] : undefined,
    query: { enabled: Boolean(router && directPath && amountIn) },
  });

  const directQuotePending = unresolved(Boolean(directPath && amountIn), directQuote);
  const directOutput = directQuote.error || directQuotePending ? undefined : finalAmount(directQuote.data);

  if (isOracleRoute) {
    return {
      amountOut: undefined,
      directLive: false,
      discoverySettled: true,
      error: undefined,
      isFetching: false,
      kind: "oracle" as const,
      path: undefined,
      quotesSettled: true,
    };
  }

  if (discoveryPending) {
    return {
      amountOut: undefined,
      directLive,
      discoverySettled: false,
      error: undefined,
      isFetching: true,
      kind: "checking" as const,
      path: undefined,
      quotesSettled: false,
    };
  }

  const defaultKind: SwapRouteKind = directPath ? "direct" : "unavailable";
  const discoveryError = currentError(canProbe, directPairQuery)
    ?? currentError(Boolean(directPair), directLiquidity);

  if (!amountIn) {
    return {
      amountOut: undefined,
      directLive,
      discoverySettled: true,
      error: directPath ? undefined : discoveryError,
      isFetching: false,
      kind: defaultKind,
      path: directPath,
      quotesSettled: true,
    };
  }

  if (directQuotePending) {
    return {
      amountOut: undefined,
      directLive,
      discoverySettled: true,
      error: undefined,
      isFetching: true,
      kind: "checking" as const,
      path: undefined,
      quotesSettled: false,
    };
  }

  const quoteError = directOutput === undefined && directPath
    ? directQuote.error ?? new Error("No executable quote is available.")
    : undefined;
  return {
    amountOut: directOutput,
    directLive,
    discoverySettled: true,
    error: quoteError ?? (directOutput === undefined ? discoveryError : undefined),
    isFetching: false,
    kind: directOutput === undefined ? "unavailable" : "direct",
    path: directOutput === undefined ? undefined : directPath,
    quotesSettled: true,
  };
}
