import { type Address, type Hex, zeroAddress } from "viem";
import {
  dexFactoryAbi,
  dexPoolAbi,
  dexRouterAbi,
  erc20Abi,
  nusdOracleAbi,
  zeroXPumpAbi,
} from "../../abis";
import type { WalletToken } from "../../config/assets";
import { CONTRACTS } from "../../config/contracts";
import { t } from "../i18n";
import { formatAmount } from "../lib/format";
import {
  applySlippage,
  endToEndMinOut,
  type QuoteIdentity,
  quoteMatches,
} from "../lib/swapMath";
import { publicClient } from "../rpc/client";
import { ensureAllowance, type TxLine, writeCall } from "./tx";

/**
 * SWAP. AMM/oracle shapes compete on delivered output, while an active 0xPump
 * bonding curve is selected first for its non-graduated token markets. The
 * direct pool, NUSD bridge, and oracle-spliced shapes remain the fallback.
 *
 * The oracle legs matter because WzkLTC/NUSD is one thin pool while
 * `mintAtOracle`/`redeemAtOracle` settle at the DIA feed for no fee. The router
 * has no oracle entry point, so those two shapes cost two confirmations: stage
 * two spends the NUSD that actually landed and scales its floor down in the
 * same proportion. Pool output is concave, so a linear down-scale is always a
 * safe floor — and the floor is never scaled up.
 */
export type SwapRouteKind =
  | "oracle"
  | "direct"
  | "via-nusd"
  | "oracle-mint"
  | "oracle-redeem"
  | "pump-buy"
  | "pump-sell"
  | "none";

export interface SwapRoute extends QuoteIdentity {
  /** Inputs this quote belongs to; execution rejects a route from an older form. */
  tokenInId: string;
  tokenOutId: string;
  quotedAmountIn: bigint;
  kind: SwapRouteKind;
  /** Delivered output in the receive token's decimals; 0n when there is none. */
  amountOut: bigint;
  /** The router hops. Empty for a pure oracle settlement. */
  path: readonly Address[];
  /** NUSD handed across the oracle boundary on a staged route. */
  bridgeAmount?: bigint;
  /** Router fee for the pool part in bps; null when unread, 0 for the oracle. */
  feeBps: number | null;
  /** Wallet confirmations the route needs, approvals aside. */
  stages: 1 | 2;
  /** Fail closed: a pause flag that could not be read reads as paused. */
  paused: boolean;
}

interface FeeSchedule {
  lpBps: number;
  protocolBps: number;
  surchargeBps: number;
}

const DEADLINE_MINUTES = 20;
const PUMP_TRADE_FEE_BPS = 10;
const PUMP_TRADING = 1;
const PUMP_READY = 2;

/** The pool token for a side: the native coin trades as WzkLTC. */
function poolAddress(token: WalletToken): Address {
  return token.address ?? CONTRACTS.wzkltc;
}

function isNative(token: WalletToken): boolean {
  return !token.address;
}

function same(a: Address, b: Address): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function deadline(): bigint {
  return BigInt(Math.floor(Date.now() / 1000) + DEADLINE_MINUTES * 60);
}

function feeFor(hops: number, fees: FeeSchedule | null): number | null {
  if (!fees) return null;
  return hops * fees.lpBps + fees.protocolBps + (hops > 1 ? fees.surchargeBps : 0);
}

/** Both pause reads fail closed, so an unreachable node cannot enable a swap. */
async function swapsPaused(): Promise<boolean> {
  return publicClient
    .readContract({
      address: CONTRACTS.dexFactory,
      abi: dexFactoryAbi,
      functionName: "swapsPaused",
    })
    .catch(() => true);
}

async function oraclePaused(leg: "mint" | "redeem"): Promise<boolean> {
  return publicClient
    .readContract({
      address: CONTRACTS.nusd,
      abi: nusdOracleAbi,
      functionName: leg === "mint" ? "mintPaused" : "redeemPaused",
    })
    .catch(() => true);
}

/** Pump is fail-closed: an unavailable status is treated as no market. */
async function pumpStatus(token: Address): Promise<number> {
  const status = await publicClient
    .readContract({
      address: CONTRACTS.pumpFactory,
      abi: zeroXPumpAbi,
      functionName: "status",
      args: [token],
    })
    .catch(() => 0n);
  return Number(status);
}

/** An unreadable pause flag must never enable a Pump trade. */
async function pumpPaused(): Promise<boolean> {
  return publicClient
    .readContract({
      address: CONTRACTS.pumpFactory,
      abi: zeroXPumpAbi,
      functionName: "paused",
    })
    .catch(() => true);
}

async function pumpBuyQuote(
  token: Address,
  amountIn: bigint,
): Promise<readonly [bigint, bigint, bigint, bigint, boolean] | undefined> {
  const quote = await publicClient
    .readContract({
      address: CONTRACTS.pumpFactory,
      abi: zeroXPumpAbi,
      functionName: "quoteBuy",
      args: [token, amountIn],
    })
    .catch(() => undefined);
  return quote as readonly [bigint, bigint, bigint, bigint, boolean] | undefined;
}

async function pumpSellQuote(
  token: Address,
  amountIn: bigint,
): Promise<readonly [bigint, bigint, bigint] | undefined> {
  const quote = await publicClient
    .readContract({
      address: CONTRACTS.pumpFactory,
      abi: zeroXPumpAbi,
      functionName: "quoteSell",
      args: [token, amountIn],
    })
    .catch(() => undefined);
  return quote as readonly [bigint, bigint, bigint] | undefined;
}

/**
 * A non-zero pair mapping is immutable, so it is worth remembering. An empty one
 * is never cached: the pool can be created later in the same session.
 */
const pairCache = new Map<string, Address>();

function pairKey(a: Address, b: Address): string {
  return [a.toLowerCase(), b.toLowerCase()].sort().join(":");
}

let feeSchedule: Promise<FeeSchedule | null> | null = null;

/** LP, protocol and surcharge are router constants: read once per session. */
function routerFees(): Promise<FeeSchedule | null> {
  const router = { address: CONTRACTS.dexRouter, abi: dexRouterAbi } as const;
  feeSchedule ??= publicClient
    .multicall({
      allowFailure: false,
      contracts: [
        { ...router, functionName: "LP_FEE_BPS" },
        { ...router, functionName: "PROTOCOL_FEE_BPS" },
        { ...router, functionName: "ROUTE_SURCHARGE_BPS" },
      ] as const,
    })
    .then(([lp, protocol, surcharge]) => ({
      lpBps: Number(lp),
      protocolBps: Number(protocol),
      surchargeBps: Number(surcharge),
    }))
    .catch(() => {
      // Let the next quote try again rather than pinning an unknown fee.
      feeSchedule = null;
      return null;
    });
  return feeSchedule;
}

async function findPair(a: Address, b: Address): Promise<Address | undefined> {
  const key = pairKey(a, b);
  const cached = pairCache.get(key);
  if (cached) return cached;
  const pair = await publicClient
    .readContract({
      address: CONTRACTS.dexFactory,
      abi: dexFactoryAbi,
      functionName: "getPair",
      args: [a, b],
    })
    .catch(() => undefined);
  if (!pair || same(pair, zeroAddress)) return undefined;
  pairCache.set(key, pair);
  return pair;
}

/** A pool only counts as a route when both reserves and its LP supply are live. */
async function hasLiquidity(pair: Address | undefined): Promise<boolean> {
  if (!pair) return false;
  const [reserves, supply] = await Promise.all([
    publicClient
      .readContract({ address: pair, abi: dexPoolAbi, functionName: "getReserves" })
      .catch(() => undefined),
    publicClient
      .readContract({ address: pair, abi: erc20Abi, functionName: "totalSupply" })
      .catch(() => undefined),
  ]);
  return Boolean(reserves && reserves[0] > 0n && reserves[1] > 0n && supply && supply > 0n);
}

async function amountsOut(
  path: readonly Address[] | undefined,
  amountIn: bigint,
): Promise<bigint | undefined> {
  if (!path || amountIn <= 0n) return undefined;
  const amounts = await publicClient
    .readContract({
      address: CONTRACTS.dexRouter,
      abi: dexRouterAbi,
      functionName: "getAmountsOut",
      args: [amountIn, [...path]],
    })
    .catch(() => undefined);
  const out = amounts?.at(-1);
  return out && out > 0n ? out : undefined;
}

async function oracleQuote(
  leg: "mint" | "redeem",
  amount: bigint | undefined,
): Promise<bigint | undefined> {
  if (!amount || amount <= 0n) return undefined;
  const out = await publicClient
    .readContract({
      address: CONTRACTS.nusd,
      abi: nusdOracleAbi,
      functionName: leg === "mint" ? "quoteMint" : "quoteRedeem",
      args: [amount],
    })
    .catch(() => undefined);
  return out && out > 0n ? out : undefined;
}

function noRoute(
  tokenInId: string,
  tokenOutId: string,
  quotedAmountIn: bigint,
  paused = false,
): SwapRoute {
  return {
    tokenInId,
    tokenOutId,
    quotedAmountIn,
    kind: "none",
    amountOut: 0n,
    path: [],
    feeBps: null,
    stages: 1,
    paused,
  };
}

/**
 * Quotes every shape that exists for the pair and returns the one that delivers
 * most. Reads run in waves of concurrent calls; the client aggregates each wave
 * into a single multicall, so a full quote costs three round trips at worst.
 */
export async function quoteSwap(params: {
  tokenIn: WalletToken;
  tokenOut: WalletToken;
  amountIn: bigint;
}): Promise<SwapRoute> {
  const { tokenIn, tokenOut, amountIn } = params;
  const input = poolAddress(tokenIn);
  const output = poolAddress(tokenOut);
  const nusd = CONTRACTS.nusd;
  const identity = {
    tokenInId: tokenIn.id,
    tokenOutId: tokenOut.id,
    quotedAmountIn: amountIn,
  } as const;
  if (same(input, output) || amountIn <= 0n) {
    return noRoute(tokenIn.id, tokenOut.id, amountIn);
  }

  // zkLTC ↔ NUSD never needs a pool: the oracle settles it at the feed, no fee.
  const pureOracle = (isNative(tokenIn) && same(output, nusd))
    || (same(input, nusd) && isNative(tokenOut));
  if (pureOracle) {
    const leg = isNative(tokenIn) ? "mint" : "redeem";
    const [out, paused] = await Promise.all([oracleQuote(leg, amountIn), oraclePaused(leg)]);
    return {
      ...identity,
      kind: "oracle",
      amountOut: out ?? 0n,
      path: [],
      feeBps: 0,
      stages: 1,
      paused,
    };
  }

  // A token launched through 0xPump trades on its bonding curve until the
  // market graduates. Prefer that market over any incidental AMM pair: Pump
  // owns the canonical quote and enforces the launch lifecycle on-chain.
  const buyingPumpToken = same(input, nusd) && tokenOut.address;
  const sellingPumpToken = same(output, nusd) && tokenIn.address;
  const pumpToken = buyingPumpToken || sellingPumpToken;
  if (pumpToken) {
    const buying = Boolean(buyingPumpToken);
    const [status, paused] = await Promise.all([pumpStatus(pumpToken), pumpPaused()]);
    if (status === PUMP_READY && buying) {
      // READY means the curve has closed. The AMM becomes the source of truth
      // only after graduation, so never show a misleading buy quote here.
      return noRoute(tokenIn.id, tokenOut.id, amountIn, paused);
    }
    const pumpActive = status === PUMP_TRADING || (status === PUMP_READY && !buying);
    if (pumpActive) {
      if (buying) {
        const quote = await pumpBuyQuote(pumpToken, amountIn);
        return {
          ...identity,
          kind: "pump-buy",
          amountOut: quote?.[0] ?? 0n,
          path: [input, output],
          feeBps: PUMP_TRADE_FEE_BPS,
          stages: 1,
          paused,
        };
      }
      const quote = await pumpSellQuote(pumpToken, amountIn);
      return {
        ...identity,
        kind: "pump-sell",
        amountOut: quote?.[1] ?? 0n,
        path: [input, output],
        feeBps: PUMP_TRADE_FEE_BPS,
        stages: 1,
        paused,
      };
    }
  }

  const canBridge = !same(input, nusd) && !same(output, nusd);
  const [direct, inToNusd, nusdToOut, paused, fees] = await Promise.all([
    findPair(input, output),
    canBridge ? findPair(input, nusd) : undefined,
    canBridge ? findPair(nusd, output) : undefined,
    swapsPaused(),
    routerFees(),
  ]);
  const [directLive, inLive, outLive] = await Promise.all([
    hasLiquidity(direct),
    hasLiquidity(inToNusd),
    hasLiquidity(nusdToOut),
  ]);

  const directPath = directLive ? [input, output] : undefined;
  const bridgePath = inLive && outLive ? [input, nusd, output] : undefined;
  // An oracle leg needs only the pool on its own side, so a stalled WzkLTC/NUSD
  // pool no longer takes the whole pair offline.
  const mintPath = canBridge && isNative(tokenIn) && outLive ? [nusd, output] : undefined;
  const redeemPath = canBridge && isNative(tokenOut) && inLive ? [input, nusd] : undefined;

  const [directOut, bridgeOut, mintedNusd, poolNusd, mintHalted, redeemHalted] = await Promise.all([
    amountsOut(directPath, amountIn),
    amountsOut(bridgePath, amountIn),
    mintPath ? oracleQuote("mint", amountIn) : undefined,
    amountsOut(redeemPath, amountIn),
    mintPath ? oraclePaused("mint") : false,
    redeemPath ? oraclePaused("redeem") : false,
  ]);
  const [mintPoolOut, redeemOut] = await Promise.all([
    mintPath ? amountsOut(mintPath, mintedNusd ?? 0n) : undefined,
    redeemPath ? oracleQuote("redeem", poolNusd) : undefined,
  ]);

  const candidates: readonly SwapRoute[] = [
    {
      ...identity,
      kind: "direct",
      amountOut: directOut ?? 0n,
      path: directPath ?? [],
      feeBps: feeFor(1, fees),
      stages: 1,
      paused,
    },
    {
      ...identity,
      kind: "via-nusd",
      amountOut: bridgeOut ?? 0n,
      path: bridgePath ?? [],
      feeBps: feeFor(2, fees),
      stages: 1,
      paused,
    },
    {
      ...identity,
      kind: "oracle-mint",
      amountOut: mintPoolOut ?? 0n,
      path: mintPath ?? [],
      bridgeAmount: mintedNusd,
      feeBps: feeFor(1, fees),
      stages: 2,
      paused: paused || mintHalted,
    },
    {
      ...identity,
      kind: "oracle-redeem",
      amountOut: redeemOut ?? 0n,
      path: redeemPath ?? [],
      bridgeAmount: poolNusd,
      feeBps: feeFor(1, fees),
      stages: 2,
      paused: paused || redeemHalted,
    },
  ];

  // Comparing on delivered output rather than preferring one shape keeps the
  // choice correct in both directions, whichever side is cheaper at the time.
  return candidates.reduce<SwapRoute>((winner, candidate) => {
    if (candidate.path.length === 0 || candidate.amountOut <= 0n) return winner;
    return candidate.amountOut > winner.amountOut ? candidate : winner;
  }, noRoute(tokenIn.id, tokenOut.id, amountIn, paused));
}

/** The route line under the form, including the selected 0xPump market. */
export function routeLabel(route: SwapRoute, from: string, to: string): string | null {
  switch (route.kind) {
    case "oracle":
    case "direct":
      return `${from} → ${to}`;
    case "via-nusd":
    case "oracle-mint":
    case "oracle-redeem":
      return `${from} → NUSD → ${to}`;
    case "pump-buy":
    case "pump-sell":
      return `${from} → ${to} · 0xPump`;
    default:
      return null;
  }
}

function nusdBalance(account: Address): Promise<bigint> {
  return publicClient.readContract({
    address: CONTRACTS.nusd,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [account],
  });
}

/** A staged route may not start its second leg until the first one has landed. */
async function settled(hash: Hex): Promise<void> {
  const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 180_000 });
  if (receipt.status !== "success") throw new Error(t("err.txReverted"));
}

function routerSwap(params: TxLine & {
  from: Address;
  amountIn: bigint;
  minOut: bigint;
  path: readonly Address[];
  payNative: boolean;
  receiveNative: boolean;
}): Promise<Hex> {
  const route = [...params.path];
  const functionName = params.payNative
    ? "swapExactNativeForTokens"
    : params.receiveNative
      ? "swapExactTokensForNative"
      : "swapExactTokensForTokens";
  const args = params.payNative
    ? [params.minOut, route, params.from, deadline()]
    : [params.amountIn, params.minOut, route, params.from, deadline()];
  return writeCall({
    from: params.from,
    address: CONTRACTS.dexRouter,
    abi: dexRouterAbi,
    functionName,
    args,
    value: params.payNative ? params.amountIn : undefined,
    kind: "swap",
    label: params.label,
    detail: params.detail,
    detailLabel: params.detailLabel,
  });
}

/**
 * Executes the route the user was quoted. A pool route is one confirmation
 * (plus an approval when the pay side is an ERC-20); an oracle-bridged route is
 * two, and the second leg is built from the NUSD that actually arrived.
 */
export async function executeSwap(params: {
  from: Address;
  tokenIn: WalletToken;
  tokenOut: WalletToken;
  amountIn: bigint;
  route: SwapRoute;
  slippageBps: number;
}): Promise<Hex> {
  const { from, tokenIn, tokenOut, amountIn, route, slippageBps } = params;
  if (!quoteMatches(route, tokenIn.id, tokenOut.id, amountIn)) {
    throw new Error(t("err.quoteStale"));
  }
  if (route.kind === "none" || route.amountOut <= 0n) throw new Error(t("err.noLiquidity"));
  if (route.paused) throw new Error(t("err.swapPaused"));

  const paid = `${formatAmount(amountIn, tokenIn.decimals, 4)} ${tokenIn.symbol}`;
  const received = `${formatAmount(route.amountOut, tokenOut.decimals, 4)} ${tokenOut.symbol}`;
  const label = { key: "tx.swap", params: { paid, received } } as const;
  const minOut = endToEndMinOut(route.amountOut, slippageBps);

  if (route.kind === "oracle") {
    const oracle = { from, address: CONTRACTS.nusd, abi: nusdOracleAbi, kind: "swap" } as const;
    return isNative(tokenIn)
      ? writeCall({
          ...oracle,
          functionName: "mintAtOracle",
          args: [minOut, from],
          value: amountIn,
          label,
          detailLabel: { key: "swap.oracleNoFee" },
        })
      : writeCall({
          ...oracle,
          functionName: "redeemAtOracle",
          args: [amountIn, minOut, from],
          label,
          detailLabel: { key: "swap.oracleNoFee" },
      });
  }
  if (route.kind === "pump-buy" || route.kind === "pump-sell") {
    const pumpToken = route.kind === "pump-buy" ? tokenOut.address : tokenIn.address;
    if (!pumpToken) throw new Error(t("err.quoteStale"));
    await ensureAllowance({
      from,
      token: route.kind === "pump-buy" ? CONTRACTS.nusd : pumpToken,
      spender: CONTRACTS.pumpFactory,
      amount: amountIn,
      symbol: route.kind === "pump-buy" ? "NUSD" : tokenIn.symbol,
    });
    return writeCall({
      from,
      address: CONTRACTS.pumpFactory,
      abi: zeroXPumpAbi,
      functionName: route.kind === "pump-buy" ? "buy" : "sell",
      args: [pumpToken, amountIn, minOut, deadline()],
      kind: "swap",
      label,
      detail: routeLabel(route, tokenIn.symbol, tokenOut.symbol) ?? undefined,
    });
  }
  if (route.kind === "direct" || route.kind === "via-nusd") {
    if (!isNative(tokenIn)) {
      await ensureAllowance({
        from,
        token: poolAddress(tokenIn),
        spender: CONTRACTS.dexRouter,
        amount: amountIn,
        symbol: tokenIn.symbol,
      });
    }
    return routerSwap({
      from,
      amountIn,
      minOut,
      path: route.path,
      payNative: isNative(tokenIn),
      receiveNative: isNative(tokenOut),
      label,
      detail: routeLabel(route, tokenIn.symbol, tokenOut.symbol) ?? undefined,
    });
  }

  const bridgeAmount = route.bridgeAmount;
  if (!bridgeAmount || bridgeAmount <= 0n) throw new Error(t("err.quoteStale"));
  // Slippage is an end-to-end promise. Stage one may deliver less bridge NUSD,
  // but lowering the final floor again would compound the configured tolerance.
  // If the second leg cannot still deliver minOut it reverts and leaves the
  // bridge asset in the wallet instead of settling below the displayed limit.

  if (route.kind === "oracle-mint") {
    const before = await nusdBalance(from);
    const minted = await writeCall({
      from,
      address: CONTRACTS.nusd,
      abi: nusdOracleAbi,
      functionName: "mintAtOracle",
      args: [applySlippage(bridgeAmount, slippageBps), from],
      value: amountIn,
      kind: "swap",
      label,
      detailLabel: { key: "swap.step1Oracle", params: { symbol: tokenIn.symbol } },
    });
    await settled(minted);
    const delivered = (await nusdBalance(from)) - before;
    if (delivered <= 0n) throw new Error(t("err.noNusdDelivered"));
    await ensureAllowance({
      from,
      token: CONTRACTS.nusd,
      spender: CONTRACTS.dexRouter,
      amount: delivered,
      symbol: "NUSD",
    });
    return routerSwap({
      from,
      amountIn: delivered,
      minOut,
      path: route.path,
      payNative: false,
      receiveNative: isNative(tokenOut),
      label,
      detailLabel: { key: "swap.step2Pool", params: { symbol: tokenOut.symbol } },
    });
  }

  await ensureAllowance({
    from,
    token: poolAddress(tokenIn),
    spender: CONTRACTS.dexRouter,
    amount: amountIn,
    symbol: tokenIn.symbol,
  });
  const before = await nusdBalance(from);
  const sold = await routerSwap({
    from,
    amountIn,
    minOut: applySlippage(bridgeAmount, slippageBps),
    path: route.path,
    payNative: false,
    receiveNative: false,
    label,
    detailLabel: { key: "swap.step1Pool", params: { symbol: tokenIn.symbol } },
  });
  await settled(sold);
  const delivered = (await nusdBalance(from)) - before;
  if (delivered <= 0n) throw new Error(t("err.noNusdDelivered"));
  return writeCall({
    from,
    address: CONTRACTS.nusd,
    abi: nusdOracleAbi,
    functionName: "redeemAtOracle",
    args: [delivered, minOut, from],
    kind: "swap",
    label,
    detailLabel: { key: "swap.step2Oracle", params: { symbol: tokenOut.symbol } },
  });
}
