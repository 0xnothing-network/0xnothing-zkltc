"use client";

import { zeroAddress, type Address } from "viem";
import { useReadContract, useReadContracts } from "wagmi";
import { dexFactoryAbi, dexPoolAbi, dexRouterAbi } from "@fi/lib/abis/dex";
import { nusdOracleAbi } from "@fi/lib/abis/nusd";

export type SwapRouteKind =
  | "oracle"
  | "direct"
  | "via-nusd"
  | "oracle-mint"
  | "oracle-redeem"
  | "checking"
  | "unavailable";
export type SwapOracleLeg = "mint" | "redeem";
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

interface RouteCandidate {
  amountOut?: bigint;
  /** The NUSD amount handed across the oracle boundary, when there is one. */
  bridgeAmount?: bigint;
  fetching: boolean;
  kind: SwapRouteKind;
  oracleLeg?: SwapOracleLeg;
  /** The DEX hop or hops the router executes. Empty for a pure oracle route. */
  path?: SwapPath;
  poolAmountIn?: bigint;
  poolAmountOut?: bigint;
}

/**
 * Picks the best available route for a pair and quotes it.
 *
 * Four candidates compete on delivered output: the direct pool, the NUSD pool
 * bridge, and — when one side is native zkLTC — the NUSD oracle mint or redeem
 * spliced onto a single pool hop. The oracle legs matter because the
 * WzkLTC/NUSD pool is one thin pool among many, while `mintAtOracle` and
 * `redeemAtOracle` settle at the feed price for no fee. Comparing on output
 * rather than preferring one shape keeps the choice correct in both directions
 * whichever side is cheaper at the time.
 */
export function useSwapRoute({
  amountIn,
  bridge,
  factory,
  input,
  isOracleRoute,
  oracleMintable = false,
  oracleRedeemable = false,
  output,
  router,
}: {
  amountIn?: bigint;
  bridge?: Address;
  factory?: Address;
  input?: Address;
  isOracleRoute: boolean;
  /** The pay side is native zkLTC, so NUSD can be minted at the oracle. */
  oracleMintable?: boolean;
  /** The receive side is native zkLTC, so NUSD can be redeemed at the oracle. */
  oracleRedeemable?: boolean;
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
  // The oracle legs need only the pool on their own side, so a stalled
  // WzkLTC/NUSD pool no longer takes the whole pair offline.
  const mintPoolPath: SwapPath | undefined = canProbeBridge && oracleMintable
    && bridgeOutPair.live && bridge && output
    ? [bridge, output]
    : undefined;
  const redeemPoolPath: SwapPath | undefined = canProbeBridge && oracleRedeemable
    && bridgeInPair.live && input && bridge
    ? [input, bridge]
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
  const mintLegQuote = useReadContract({
    address: bridge,
    abi: nusdOracleAbi,
    functionName: "quoteMint",
    args: mintPoolPath && amountIn ? [amountIn] : undefined,
    query: {
      enabled: Boolean(bridge && mintPoolPath && amountIn),
      refetchInterval: SWAP_QUOTE_REFRESH_MS,
      refetchIntervalInBackground: false,
    },
  });
  const mintedNusd = mintLegQuote.error ? undefined : mintLegQuote.data;
  const mintPoolQuote = useReadContract({
    address: router,
    abi: dexRouterAbi,
    functionName: "getAmountsOut",
    args: mintPoolPath && mintedNusd ? [mintedNusd, [...mintPoolPath]] : undefined,
    query: {
      enabled: Boolean(router && mintPoolPath && mintedNusd),
      refetchInterval: SWAP_QUOTE_REFRESH_MS,
      refetchIntervalInBackground: false,
    },
  });

  const redeemPoolQuote = useReadContract({
    address: router,
    abi: dexRouterAbi,
    functionName: "getAmountsOut",
    args: redeemPoolPath && amountIn ? [amountIn, [...redeemPoolPath]] : undefined,
    query: {
      enabled: Boolean(router && redeemPoolPath && amountIn),
      refetchInterval: SWAP_QUOTE_REFRESH_MS,
      refetchIntervalInBackground: false,
    },
  });
  const redeemNusd = redeemPoolQuote.error ? undefined : finalAmount(redeemPoolQuote.data);
  const redeemLegQuote = useReadContract({
    address: bridge,
    abi: nusdOracleAbi,
    functionName: "quoteRedeem",
    args: redeemPoolPath && redeemNusd ? [redeemNusd] : undefined,
    query: {
      enabled: Boolean(bridge && redeemPoolPath && redeemNusd),
      refetchInterval: SWAP_QUOTE_REFRESH_MS,
      refetchIntervalInBackground: false,
    },
  });
  const empty = {
    amountInQuoted: undefined,
    amountOut: undefined,
    bridgeAmount: undefined,
    oracleLeg: undefined,
    path: undefined,
    poolAmountIn: undefined,
    poolAmountOut: undefined,
  };

  if (isOracleRoute) {
    return {
      ...empty,
      bridgeLive: false,
      directLive: false,
      discoverySettled: true,
      error: undefined,
      isFetching: false,
      kind: "oracle" as const,
      quotesSettled: true,
    };
  }

  const discoveryPending = directPair.pending || bridgeInPair.pending || bridgeOutPair.pending;
  if (discoveryPending) {
    return {
      ...empty,
      bridgeLive,
      directLive: directPair.live,
      discoverySettled: false,
      error: undefined,
      isFetching: true,
      kind: "checking" as const,
      quotesSettled: false,
    };
  }

  const discoveryError = directPair.error ?? bridgeInPair.error ?? bridgeOutPair.error;
  const discoveryPath = directPath ?? bridgePath ?? mintPoolPath ?? redeemPoolPath;
  const discoveryKind: SwapRouteKind = directPath
    ? "direct"
    : bridgePath
      ? "via-nusd"
      : mintPoolPath
        ? "oracle-mint"
        : redeemPoolPath
          ? "oracle-redeem"
          : "unavailable";
  if (!amountIn) {
    return {
      ...empty,
      bridgeLive,
      directLive: directPair.live,
      discoverySettled: true,
      error: discoveryPath ? undefined : discoveryError,
      isFetching: false,
      kind: discoveryKind,
      oracleLeg: discoveryKind === "oracle-mint"
        ? "mint" as const
        : discoveryKind === "oracle-redeem" ? "redeem" as const : undefined,
      path: discoveryPath,
      quotesSettled: true,
    };
  }

  const quotesPending = unresolved(Boolean(directPath), directQuote)
    || unresolved(Boolean(bridgePath), bridgeQuote)
    || unresolved(Boolean(mintPoolPath), mintLegQuote)
    || unresolved(Boolean(mintPoolPath && mintedNusd), mintPoolQuote)
    || unresolved(Boolean(redeemPoolPath), redeemPoolQuote)
    || unresolved(Boolean(redeemPoolPath && redeemNusd), redeemLegQuote);
  if (quotesPending) {
    return {
      ...empty,
      bridgeLive,
      directLive: directPair.live,
      discoverySettled: true,
      error: undefined,
      isFetching: true,
      kind: "checking" as const,
      quotesSettled: false,
    };
  }
  const mintPoolOutput = mintPoolQuote.error ? undefined : finalAmount(mintPoolQuote.data);
  const redeemOutput = redeemLegQuote.error ? undefined : redeemLegQuote.data;
  const candidates: readonly RouteCandidate[] = [
    {
      amountOut: directQuote.error ? undefined : finalAmount(directQuote.data),
      fetching: directQuote.isFetching,
      kind: "direct",
      path: directPath,
      poolAmountIn: amountIn,
      poolAmountOut: directQuote.error ? undefined : finalAmount(directQuote.data),
    },
    {
      amountOut: bridgeQuote.error ? undefined : finalAmount(bridgeQuote.data),
      fetching: bridgeQuote.isFetching,
      kind: "via-nusd",
      path: bridgePath,
      poolAmountIn: amountIn,
      poolAmountOut: bridgeQuote.error ? undefined : finalAmount(bridgeQuote.data),
    },
    {
      amountOut: mintPoolOutput,
      bridgeAmount: mintedNusd,
      fetching: mintLegQuote.isFetching || mintPoolQuote.isFetching,
      kind: "oracle-mint",
      oracleLeg: "mint",
      path: mintPoolPath,
      poolAmountIn: mintedNusd,
      poolAmountOut: mintPoolOutput,
    },
    {
      amountOut: redeemOutput,
      bridgeAmount: redeemNusd,
      fetching: redeemPoolQuote.isFetching || redeemLegQuote.isFetching,
      kind: "oracle-redeem",
      oracleLeg: "redeem",
      path: redeemPoolPath,
      poolAmountIn: amountIn,
      poolAmountOut: redeemNusd,
    },
  ];
  const best = candidates.reduce<RouteCandidate | undefined>((winner, candidate) => {
    if (!candidate.path || candidate.amountOut === undefined) return winner;
    if (!winner || winner.amountOut === undefined) return candidate;
    return candidate.amountOut > winner.amountOut ? candidate : winner;
  }, undefined);
  const amountOut = best?.amountOut;
  // A cached quote may remain visible during a background refresh, but it is
  // never executable until the selected candidate has settled for this key.
  const candidateQuoteRefreshing = Boolean(best?.fetching);
  const quoteError = amountOut === undefined && discoveryPath
    ? directQuote.error
      ?? bridgeQuote.error
      ?? mintLegQuote.error
      ?? mintPoolQuote.error
      ?? redeemPoolQuote.error
      ?? redeemLegQuote.error
      ?? new Error("No executable quote is available.")
    : undefined;

  return {
    amountInQuoted: amountOut === undefined || candidateQuoteRefreshing ? undefined : amountIn,
    amountOut,
    bridgeAmount: best?.bridgeAmount,
    bridgeLive,
    directLive: directPair.live,
    discoverySettled: true,
    error: quoteError ?? (amountOut === undefined ? discoveryError : undefined),
    isFetching: false,
    kind: best?.kind ?? "unavailable" as const,
    oracleLeg: best?.oracleLeg,
    path: best?.path,
    poolAmountIn: best?.poolAmountIn,
    poolAmountOut: best?.poolAmountOut,
    quotesSettled: true,
  };
}
