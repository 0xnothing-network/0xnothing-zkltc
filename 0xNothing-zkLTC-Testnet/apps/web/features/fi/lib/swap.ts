import { isAddress, type Address } from "viem";
import { formatTokenAmount } from "@fi/lib/format";
import type { useImportedSwapAsset } from "@fi/lib/hooks/useImportedSwapAsset";
import type { SwapAsset } from "@fi/lib/hooks/useSwapAssets";
import type { SwapRouteKind } from "@fi/lib/hooks/useSwapRoute";

/**
 * Swap terminal logic that does not touch React: deep-link parsing, quote and
 * impact math, the router call shape, and the status copy the form shows.
 * SwapWorkspace keeps the state and the markup; everything here is pure, so
 * each side can be read and changed without carrying the other in your head.
 */

// A native swap leaves a gas float behind so a max-in swap cannot strand the wallet.
const NATIVE_GAS_RESERVE_WEI = 10_000_000_000_000_000n;
const RATE_PRECISION = 10n ** 18n;
const CANONICAL_SWAP_IDS = new Set(["zkLTC", "NUSD", "nBTC", "nETH"]);

export const ORACLE_QUOTE_REFRESH_MS = 7_000;

export type ImportSide = "pay" | "receive";
type ImportedSwapAsset = ReturnType<typeof useImportedSwapAsset>;

export interface SwapDeepLink {
  importSide?: ImportSide;
  payContract?: string;
  receiveContract?: string;
  tokenIn?: string;
  tokenOut?: string;
}

/**
 * `?in=` / `?out=` take either a canonical asset id or a token address. A link
 * that names the same asset on both sides keeps the pay side and moves the
 * receive side away, so the form never opens on an impossible pair.
 */
export function readSwapDeepLink(search: string): SwapDeepLink {
  const params = new URLSearchParams(search);
  const requestedIn = params.get("in");
  const requestedOut = params.get("out");
  const duplicateRequest = Boolean(
    requestedIn && requestedOut && requestedIn.toLowerCase() === requestedOut.toLowerCase(),
  );
  const link: SwapDeepLink = {};

  if (requestedIn) {
    if (CANONICAL_SWAP_IDS.has(requestedIn)) {
      link.tokenIn = requestedIn;
      if (duplicateRequest && requestedIn === "NUSD") link.tokenOut = "zkLTC";
    } else if (isAddress(requestedIn)) {
      link.payContract = requestedIn;
      link.importSide = "pay";
    }
  }
  if (requestedOut && !duplicateRequest) {
    if (CANONICAL_SWAP_IDS.has(requestedOut)) {
      link.tokenOut = requestedOut;
    } else if (isAddress(requestedOut)) {
      link.receiveContract = requestedOut;
      link.importSide = "receive";
    }
  }
  return link;
}

/** Explorer-verified metadata wins for imported tokens; the core list keeps its own. */
export function mergeVerifiedMetadata(asset: SwapAsset, verified: SwapAsset): SwapAsset {
  return {
    ...asset,
    ...(asset.trustedCore ? {} : {
      decimals: verified.decimals,
      name: verified.name,
      symbol: verified.symbol,
    }),
    explorerStatus: verified.explorerStatus,
    metadataSource: verified.metadataSource,
  };
}

export function spendableSwapBalance(
  balance: bigint | undefined,
  native: boolean,
): bigint | undefined {
  if (!native || balance === undefined) return balance;
  return balance > NATIVE_GAS_RESERVE_WEI ? balance - NATIVE_GAS_RESERVE_WEI : 0n;
}

export function quotedRate(
  amountIn: bigint | undefined,
  inputDecimals: number,
  amountOut: bigint | undefined,
  outputDecimals: number,
): string | undefined {
  if (!amountIn || !amountOut) return undefined;
  const inputScale = 10n ** BigInt(inputDecimals);
  const outputScale = 10n ** BigInt(outputDecimals);
  const rate = amountOut * inputScale * RATE_PRECISION / (amountIn * outputScale);
  return formatTokenAmount(rate, 18);
}

/**
 * How far the quote lands below the fee-free constant-product spot value, in
 * basis points. Undefined as soon as one reserve read is missing, so the form
 * shows "--" instead of an impact that was never measured.
 */
export function computeExecutionImpactBps({
  amountIn,
  amountOut,
  hops,
  reserveReads,
}: {
  amountIn?: bigint;
  amountOut?: bigint;
  hops?: number;
  reserveReads?: readonly { result?: unknown }[];
}): bigint | undefined {
  if (!amountIn || !amountOut || hops === undefined || reserveReads?.length !== hops) {
    return undefined;
  }
  let spotOutput = amountIn;
  for (const read of reserveReads) {
    const reserves = read.result as readonly [bigint, bigint] | undefined;
    if (!reserves || reserves[0] <= 0n || reserves[1] <= 0n) return undefined;
    spotOutput = spotOutput * reserves[1] / reserves[0];
  }
  if (spotOutput <= 0n || amountOut >= spotOutput) return 0n;
  return (spotOutput - amountOut) * 10_000n / spotOutput;
}

/** Import-field copy. The tone drives the field's `data-state` styling only. */
export function importedTokenStatus(
  value: string,
  detected: SwapAsset | undefined,
  imported: ImportedSwapAsset,
): { message: string; tone: string } {
  if (!value.trim()) return { message: "Paste a token address to import it.", tone: "neutral" };
  if (imported.status === "invalid" || imported.status === "unsupported" || imported.status === "unavailable") {
    return { message: imported.error ?? "Token could not be recognized.", tone: "danger" };
  }
  if (imported.status === "loading") return { message: "Checking Explorer…", tone: "neutral" };
  if (imported.status !== "ready" || !detected) return { message: "Checking token…", tone: "neutral" };
  if (imported.metadataSource === "explorer") {
    return { message: `${detected.symbol} · Explorer verified`, tone: "positive" };
  }
  const explorerCopy = imported.explorerStatus === "not-indexed"
    ? "Explorer not indexed"
    : imported.explorerStatus === "unavailable"
      ? "Explorer unavailable"
      : "Explorer metadata invalid";
  return {
    message: `${detected.symbol} · On-chain metadata · ${explorerCopy}`,
    tone: "positive",
  };
}

export function swapRouteLabel({
  from,
  isOracleRoute,
  kind,
  to,
}: {
  from?: string;
  isOracleRoute: boolean;
  kind: SwapRouteKind;
  to?: string;
}): string | undefined {
  if (!from || !to) return undefined;
  if (isOracleRoute || kind === "direct") return `${from} → ${to}`;
  if (kind === "via-nusd") return `${from} → NUSD → ${to}`;
  return undefined;
}

/**
 * The route line under the form. It only speaks once an imported address has
 * actually resolved, so a half-typed contract never reads as "no liquidity".
 */
export function swapLiquidityStatus({
  bridgeLive,
  detected,
  directLive,
  hasImportInput,
  importsReady,
  isOracleRoute,
  kind,
  routeError,
}: {
  bridgeLive: boolean;
  detected: boolean;
  directLive: boolean;
  hasImportInput: boolean;
  importsReady: boolean;
  isOracleRoute: boolean;
  kind: SwapRouteKind;
  routeError: boolean;
}): string | undefined {
  if (!hasImportInput) return undefined;
  if (!importsReady || !detected) return undefined;
  if (isOracleRoute) return "Liquidity found · 0% fee";
  if (kind === "checking") return "Checking liquidity…";
  if (kind === "direct") {
    return bridgeLive ? "Best quote selected · Direct route" : "Direct liquidity found";
  }
  if (kind === "via-nusd") {
    return directLive ? "Best quote selected · Routed through NUSD" : "NUSD bridge liquidity found";
  }
  if (routeError) return "Liquidity check is temporarily unavailable.";
  return "No liquidity is available for this pair.";
}

/** The DEX router entry point for a pool route. */
export function buildDexSwapCall({
  amountIn,
  deadline,
  minimumOut,
  path,
  payNative,
  receiveNative,
  recipient,
}: {
  amountIn: bigint;
  deadline: bigint;
  minimumOut: bigint;
  path: readonly Address[];
  payNative: boolean;
  receiveNative: boolean;
  recipient: Address;
}): { args: readonly unknown[]; functionName: string; value?: bigint } {
  const route = [...path];
  if (payNative) {
    return {
      args: [minimumOut, route, recipient, deadline],
      functionName: "swapExactNativeForTokens",
      value: amountIn,
    };
  }
  return {
    args: [amountIn, minimumOut, route, recipient, deadline],
    functionName: receiveNative ? "swapExactTokensForNative" : "swapExactTokensForTokens",
  };
}

/**
 * Submit-button copy, ordered the way the form gates a swap: unresolved imports
 * first, then infrastructure, then the route, then the quote. The button's
 * `disabled` state is derived separately — this only names the reason.
 */
export function swapButtonLabel({
  importsReady,
  infrastructureConfigured,
  payImportStatus,
  pending,
  quoteFetching,
  receiveImportStatus,
  routeConfigured,
  routeError,
  routeKind,
  routePaused,
  routeStateReady,
}: {
  importsReady: boolean;
  infrastructureConfigured: boolean;
  payImportStatus: ImportedSwapAsset["status"];
  pending: boolean;
  quoteFetching: boolean;
  receiveImportStatus: ImportedSwapAsset["status"];
  routeConfigured: boolean;
  routeError: boolean;
  routeKind: SwapRouteKind;
  routePaused?: boolean;
  routeStateReady: boolean;
}): string {
  if (!importsReady) {
    if (payImportStatus === "unavailable" || receiveImportStatus === "unavailable") {
      return "Token check unavailable";
    }
    if (
      payImportStatus === "invalid" || payImportStatus === "unsupported"
      || receiveImportStatus === "invalid" || receiveImportStatus === "unsupported"
    ) {
      return "Check token addresses";
    }
    return "Checking tokens";
  }
  if (!infrastructureConfigured) return "Not deployed";
  if (routeKind === "checking") return "Checking liquidity";
  if (routeError) return routeKind === "unavailable" ? "Liquidity check unavailable" : "Quote unavailable";
  if (!routeConfigured) return "No liquidity";
  if (!routeStateReady) return "Checking route";
  if (routePaused) return "Swaps paused";
  if (pending) return "Processing";
  if (quoteFetching) return "Refreshing quote";
  return "Swap";
}
