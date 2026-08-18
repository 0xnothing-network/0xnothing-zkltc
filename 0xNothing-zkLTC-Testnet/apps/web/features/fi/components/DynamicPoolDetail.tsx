"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { ArrowClockwise, ArrowLeft, ArrowsDownUp, HourglassSimple, Warning } from "@phosphor-icons/react";
import { useAccount, useReadContract, useReadContracts } from "wagmi";
import { formatUnits, type Address } from "viem";
import { AmountField } from "@fi/components/AmountField";
import { ConnectWalletButton } from "@fi/components/ConnectWalletButton";
import { LazyMarketChart } from "@fi/components/LazyMarketChart";
import { RecentActivity } from "@fi/components/RecentActivity";
import { SlippageControl } from "@fi/components/SlippageControl";
import { TokenPairLogos, tokenImageUrl } from "@fi/components/TokenLogo";
import { NotDeployed, TransactionStatus } from "@fi/components/UiStates";
import { useToast } from "@fi/components/Toast";
import { deployment } from "@fi/config/deployment";
import { fiPath } from "@fi/config/paths";
import { diaOracleAdapterAbi } from "@fi/lib/abis/dia";
import { dexFactoryAbi, dexPoolAbi, dexRouterAbi } from "@fi/lib/abis/dex";
import { communityLiquidityLockerAbi } from "@fi/lib/abis/locker";
import { erc20Abi } from "@fi/lib/abis/erc20";
import { canonicalOracleMarketForIdentifier } from "@fi/lib/canonicalMarkets";
import { formatAmount, minimumAfterSlippage, parseAmount, percentageShare, priceImpactBps, transactionDeadline } from "@fi/lib/format";
import { useActiveDexRouter } from "@fi/lib/hooks/useActiveDexRouter";
import { formatFeeBps, useDexFeeSchedule } from "@fi/lib/hooks/useDexFeeSchedule";
import { useProtocolTransaction } from "@fi/lib/hooks/useProtocolTransaction";

function integerSquareRoot(value: bigint): bigint {
  if (value < 2n) return value;
  let current = value;
  let next = (current + value / current) / 2n;
  while (next < current) { current = next; next = (current + value / current) / 2n; }
  return current;
}

function displaySymbol(symbol: string | undefined): string {
  if (!symbol) return "--";
  return symbol;
}

function displayMarketPrice(value: number | undefined): string {
  if (value === undefined) return "--";
  const verySmall = Math.abs(value) < 0.0001;
  return `$${value.toLocaleString("en-US", {
    minimumFractionDigits: verySmall ? 8 : 2,
    maximumFractionDigits: verySmall ? 12 : Math.abs(value) < 1 ? 8 : 6,
  })}`;
}

function displayPriceImpact(value: bigint | undefined): string {
  if (value === undefined) return "--";
  return `${(Number(value) / 100).toFixed(2)}%`;
}

function displayUnlockTime(value: bigint | undefined): string {
  if (value === undefined) return "--";
  return `${new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(new Date(Number(value) * 1_000))} UTC`;
}

function formatLpDetailAmount(value: bigint): string {
  const whole = value / 10n ** 18n;
  const fraction = value % 10n ** 18n;
  const fractionText = fraction.toString().padStart(18, "0").slice(0, 4).replace(/0+$/, "");
  const wholeText = whole.toLocaleString("en-US");
  return fractionText ? `${wholeText}.${fractionText}` : wholeText;
}

function lpDetailPercent(amount: bigint, total: bigint): number {
  if (amount <= 0n || total <= 0n) return 0;
  return Number((amount * 1_000_000n) / total) / 10_000;
}

function formatLpDetailPercent(amount: bigint, total: bigint): string {
  return `${lpDetailPercent(amount, total).toLocaleString("en-US", { maximumFractionDigits: 2 })}%`;
}

const tokenImageAbi = [{
  type: "function", name: "imageURI", stateMutability: "view",
  inputs: [], outputs: [{ name: "", type: "string" }],
}] as const;

// LP sent here is unrecoverable; the pools directory marks such pools as Burned.
const LP_DEAD_ADDRESS = "0x000000000000000000000000000000000000dEaD";

type ActivePoolLock = {
  id: bigint;
  amount: bigint;
  unlockAt: bigint;
  permanent: boolean;
};

export function DynamicPoolDetail({ pool }: { pool: Address }) {
  const { address, isConnected } = useAccount();
  const toast = useToast();
  const tx = useProtocolTransaction();
  const dexRouter = useActiveDexRouter();
  const feeSchedule = useDexFeeSchedule(dexRouter);
  const [mode, setMode] = useState<"swap" | "add" | "remove">("swap");
  const [swapInputIndex, setSwapInputIndex] = useState<0 | 1>(0);
  const [swapAmountText, setSwapAmountText] = useState("");
  const [amountAText, setAmountAText] = useState("");
  const [amountBText, setAmountBText] = useState("");
  const [lpText, setLpText] = useState("");
  const [slippageBps, setSlippageBps] = useState(50n);
  const [lockAmountText, setLockAmountText] = useState("");
  const [lockMode, setLockMode] = useState<"permanent" | "timed">("permanent");
  const [lockUnlockAt, setLockUnlockAt] = useState<string>("");
  const [lpActionMode, setLpActionMode] = useState<"lock" | "burn">("lock");
  const [burnAmountText, setBurnAmountText] = useState("");
  const [lpSecurityOpen, setLpSecurityOpen] = useState(false);
  const [currentUnixTime, setCurrentUnixTime] = useState(() => Math.floor(Date.now() / 1_000));

  const validation = useReadContract({
    address: deployment.contracts.dexFactory,
    abi: dexFactoryAbi,
    functionName: "isPair",
    args: [pool],
    query: { enabled: Boolean(deployment.contracts.dexFactory), staleTime: 60_000 },
  });
  const pairMetadata = useReadContracts({
    contracts: [
      { address: pool, abi: dexPoolAbi, functionName: "token0" },
      { address: pool, abi: dexPoolAbi, functionName: "token1" },
    ] as const,
    query: { enabled: validation.data === true, staleTime: 5 * 60_000 },
  });
  const poolToken0 = pairMetadata.data?.[0]?.result as Address | undefined;
  const poolToken1 = pairMetadata.data?.[1]?.result as Address | undefined;
  const pairData = useReadContracts({
    contracts: [
      { address: pool, abi: dexPoolAbi, functionName: "getReserves" },
      { address: pool, abi: dexPoolAbi, functionName: "totalSupply" },
    ] as const,
    query: { enabled: validation.data === true },
  });
  const rawReserves = pairData.data?.[0]?.result as readonly [bigint, bigint, number] | undefined;
  const totalSupply = pairData.data?.[1]?.result as bigint | undefined;
  const pairMetadataReadFailed = pairMetadata.data?.some((result) => result.status === "failure") ?? false;
  const pairReadFailed = pairData.data?.some((result) => result.status === "failure") ?? false;
  const nusdAddress = deployment.contracts.nusd?.toLowerCase();
  const token0IsNusd = Boolean(poolToken0 && nusdAddress && poolToken0.toLowerCase() === nusdAddress);
  const token1IsNusd = Boolean(poolToken1 && nusdAddress && poolToken1.toLowerCase() === nusdAddress);
  const tokenA = token0IsNusd ? poolToken0 : token1IsNusd ? poolToken1 : poolToken0;
  const tokenB = token0IsNusd ? poolToken1 : token1IsNusd ? poolToken0 : poolToken1;
  const rawReserveA = token1IsNusd ? rawReserves?.[1] : rawReserves?.[0];
  const rawReserveB = token1IsNusd ? rawReserves?.[0] : rawReserves?.[1];
  const tokenMetadata = useReadContracts({
    contracts: tokenA && tokenB ? [
      { address: tokenA, abi: erc20Abi, functionName: "symbol" },
      { address: tokenB, abi: erc20Abi, functionName: "symbol" },
      { address: tokenA, abi: erc20Abi, functionName: "decimals" },
      { address: tokenB, abi: erc20Abi, functionName: "decimals" },
      { address: tokenA, abi: tokenImageAbi, functionName: "imageURI" },
      { address: tokenB, abi: tokenImageAbi, functionName: "imageURI" },
    ] as const : [],
    query: { enabled: Boolean(tokenA && tokenB), staleTime: 5 * 60_000 },
  });
  const symbolA = displaySymbol(tokenMetadata.data?.[0]?.result as string | undefined);
  const symbolB = displaySymbol(tokenMetadata.data?.[1]?.result as string | undefined);
  const decimalsA = (tokenMetadata.data?.[2]?.result as number | undefined) ?? 18;
  const decimalsB = (tokenMetadata.data?.[3]?.result as number | undefined) ?? 18;
  const amountA = parseAmount(amountAText, decimalsA);
  const amountB = parseAmount(amountBText, decimalsB);
  const liquidity = parseAmount(lpText);
  const imageA = tokenImageUrl(tokenMetadata.data?.[4]?.result as string | undefined);
  const imageB = tokenImageUrl(tokenMetadata.data?.[5]?.result as string | undefined);
  const tokenReadFailed = tokenMetadata.data?.slice(0, 4).some((result) => result.status === "failure") ?? false;
  const walletBalances = useReadContracts({
    contracts: address && tokenA && tokenB ? [
      { address: pool, abi: dexPoolAbi, functionName: "balanceOf", args: [address] },
      { address: tokenA, abi: erc20Abi, functionName: "balanceOf", args: [address] },
      { address: tokenB, abi: erc20Abi, functionName: "balanceOf", args: [address] },
    ] as const : [],
    query: { enabled: Boolean(address && tokenA && tokenB) },
  });
  const lpBalance = walletBalances.data?.[0]?.result as bigint | undefined;
  const balanceA = walletBalances.data?.[1]?.result as bigint | undefined;
  const balanceB = walletBalances.data?.[2]?.result as bigint | undefined;
  const lockedLpRead = useReadContract({
    address: deployment.contracts.lpLocker,
    abi: communityLiquidityLockerAbi,
    functionName: "activeLockedByToken",
    args: [pool],
    query: { enabled: Boolean(deployment.contracts.lpLocker), staleTime: 60_000 },
  });
  const lockedLp = lockedLpRead.data as bigint | undefined;
  const burnedLpRead = useReadContract({
    address: pool,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [LP_DEAD_ADDRESS],
    query: { staleTime: 60_000 },
  });
  const burnedLp = burnedLpRead.data as bigint | undefined;
  const ownerLockIdsRead = useReadContract({
    address: deployment.contracts.lpLocker,
    abi: communityLiquidityLockerAbi,
    functionName: "ownerLockIds",
    args: address ? [address] : undefined,
    query: { enabled: Boolean(deployment.contracts.lpLocker && address && lockedLp && lockedLp > 0n), staleTime: 30_000 },
  });
  const lockIds = useMemo(
    () => [...((ownerLockIdsRead.data as readonly bigint[] | undefined) ?? [])],
    [ownerLockIdsRead.data],
  );
  const locksRead = useReadContracts({
    contracts: deployment.contracts.lpLocker
      ? lockIds.map((id) => ({
          address: deployment.contracts.lpLocker!,
          abi: communityLiquidityLockerAbi,
          functionName: "getLock",
          args: [id],
        }) as const)
      : [],
    query: { enabled: Boolean(deployment.contracts.lpLocker && lockIds.length > 0), staleTime: 30_000 },
  });
  const activeLocks = useMemo(() => {
    const locks: ActivePoolLock[] = [];
    for (const [index, result] of (locksRead.data ?? []).entries()) {
      const lock = result.result;
      if (!lock || lock.withdrawn || lock.lpToken.toLowerCase() !== pool.toLowerCase()) continue;
      locks.push({
        id: lockIds[index],
        amount: lock.amount,
        unlockAt: lock.unlockAt,
        permanent: lock.permanent,
      });
    }
    return locks;
  }, [lockIds, locksRead.data, pool]);
  const permanentLockedLp = activeLocks.reduce(
    (total, lock) => total + (lock.permanent ? lock.amount : 0n),
    0n,
  );
  const timedLocks = activeLocks
    .filter((lock) => !lock.permanent)
    .sort((left, right) => Number(left.unlockAt - right.unlockAt));
  const timedLockedLp = timedLocks.reduce((total, lock) => total + lock.amount, 0n);
  const earliestUnlockAt = timedLocks[0]?.unlockAt;
  const hasLockedLp = lockedLp !== undefined && lockedLp > 0n;
  const hasBurnedLp = burnedLp !== undefined && burnedLp > 0n;
  const lpSecurityTotal = totalSupply ?? 0n;
  const lpSecurityLockedRaw = lockedLp ?? 0n;
  const lpSecurityLocked = lpSecurityLockedRaw > lpSecurityTotal ? lpSecurityTotal : lpSecurityLockedRaw;
  const lpSecurityBurnedLimit = lpSecurityTotal - lpSecurityLocked;
  const lpSecurityBurnedRaw = burnedLp ?? 0n;
  const lpSecurityBurned = lpSecurityBurnedRaw > lpSecurityBurnedLimit ? lpSecurityBurnedLimit : lpSecurityBurnedRaw;
  const lpSecuritySecured = lpSecurityLocked + lpSecurityBurned;
  const lpSecurityUnlocked = lpSecurityTotal - lpSecuritySecured;
  const lpSecurityLockedPercent = lpDetailPercent(lpSecurityLocked, lpSecurityTotal);
  const lpSecurityBurnedPercent = lpDetailPercent(lpSecurityBurned, lpSecurityTotal);
  const lpSecurityUnlockedPercent = Math.max(0, 100 - lpSecurityLockedPercent - lpSecurityBurnedPercent);
  const lpSecurityTooltipId = `lp-security-detail-${pool.slice(2)}`;
  const walletLocks = address ? timedLocks : [];
  const nextWalletUnlockAt = walletLocks.find(
    (lock) => lock.unlockAt > BigInt(currentUnixTime),
  )?.unlockAt;
  useEffect(() => {
    if (nextWalletUnlockAt === undefined) return;
    const remainingMs = Number(nextWalletUnlockAt) * 1_000 - Date.now();
    const delayMs = Math.min(Math.max(remainingMs + 250, 250), 2_147_000_000);
    const timer = window.setTimeout(
      () => setCurrentUnixTime(Math.floor(Date.now() / 1_000)),
      delayMs,
    );
    return () => window.clearTimeout(timer);
  }, [currentUnixTime, nextWalletUnlockAt]);
  const withdrawableLocks = walletLocks.filter(
    (lock) => lock.unlockAt <= BigInt(currentUnixTime),
  );
  const swapTokenIn = swapInputIndex === 0 ? tokenA : tokenB;
  const swapTokenOut = swapInputIndex === 0 ? tokenB : tokenA;
  const swapSymbolIn = swapInputIndex === 0 ? symbolA : symbolB;
  const swapSymbolOut = swapInputIndex === 0 ? symbolB : symbolA;
  const swapDecimalsIn = swapInputIndex === 0 ? decimalsA : decimalsB;
  const swapDecimalsOut = swapInputIndex === 0 ? decimalsB : decimalsA;
  const swapBalance = swapInputIndex === 0 ? balanceA : balanceB;
  const swapImageIn = swapInputIndex === 0 ? imageA : imageB;
  const swapImageOut = swapInputIndex === 0 ? imageB : imageA;
  const swapAmountIn = parseAmount(swapAmountText, swapDecimalsIn);
  const reserveRead = useReadContract({
    address: dexRouter,
    abi: dexRouterAbi,
    functionName: "getReserves",
    args: tokenA && tokenB ? [tokenA, tokenB] : undefined,
    query: { enabled: Boolean(dexRouter && validation.data && tokenA && tokenB) },
  });
  const reserveA = reserveRead.data?.[0] ?? rawReserveA;
  const reserveB = reserveRead.data?.[1] ?? rawReserveB;
  const tokenAIsNusd = Boolean(tokenA && nusdAddress && tokenA.toLowerCase() === nusdAddress);
  const tokenBIsNusd = Boolean(tokenB && nusdAddress && tokenB.toLowerCase() === nusdAddress);
  const displaySymbolA = tokenAIsNusd ? symbolB : symbolA;
  const displaySymbolB = tokenAIsNusd ? symbolA : symbolB;
  const displayImageA = tokenAIsNusd ? imageB : imageA;
  const displayImageB = tokenAIsNusd ? imageA : imageB;
  const nusdReserve = tokenAIsNusd ? reserveA : tokenBIsNusd ? reserveB : undefined;
  const marketReserve = tokenAIsNusd ? reserveB : tokenBIsNusd ? reserveA : undefined;
  const nusdDecimals = tokenAIsNusd ? decimalsA : decimalsB;
  const marketDecimals = tokenAIsNusd ? decimalsB : decimalsA;
  const spotPriceNusd = nusdReserve !== undefined && marketReserve && marketReserve > 0n
    ? Number(formatUnits(nusdReserve, nusdDecimals)) / Number(formatUnits(marketReserve, marketDecimals))
    : undefined;
  const canonicalMarket = canonicalOracleMarketForIdentifier(pool);
  const oraclePriceRead = useReadContract({
    address: canonicalMarket?.oracle,
    abi: diaOracleAdapterAbi,
    functionName: "readPriceWad",
    query: { enabled: Boolean(canonicalMarket?.oracle) },
  });
  const oracleFreshRead = useReadContract({
    address: canonicalMarket?.oracle,
    abi: diaOracleAdapterAbi,
    functionName: "isFresh",
    query: { enabled: Boolean(canonicalMarket?.oracle) },
  });
  const oraclePriceNusd = oracleFreshRead.data === true && oraclePriceRead.data?.[0]
    ? Number(formatUnits(oraclePriceRead.data[0], 18))
    : undefined;
  const marketPriceNusd = canonicalMarket ? oraclePriceNusd : spotPriceNusd;
  const tvlNusd = nusdReserve !== undefined ? Number(formatUnits(nusdReserve, nusdDecimals)) * 2 : undefined;
  const swapQuote = useReadContract({
    address: dexRouter,
    abi: dexRouterAbi,
    functionName: "getAmountsOut",
    args: swapTokenIn && swapTokenOut && swapAmountIn
      ? [swapAmountIn, [swapTokenIn, swapTokenOut]]
      : undefined,
    query: {
      enabled: Boolean(mode === "swap" && dexRouter && validation.data && swapTokenIn && swapTokenOut && swapAmountIn),
    },
  });
  const swapsPaused = useReadContract({
    address: deployment.contracts.dexFactory,
    abi: dexFactoryAbi,
    functionName: "swapsPaused",
    query: { enabled: Boolean(deployment.contracts.dexFactory) },
  });
  const swapAmountOut = swapQuote.data?.at(-1);
  // Direct-path depth impact is determined only by post-fee input versus input reserve.
  const reserveIn = swapInputIndex === 0 ? reserveA : reserveB;
  const swapFeeBps = feeSchedule
    ? BigInt(feeSchedule.lpFeeBps + feeSchedule.protocolFeeBps)
    : undefined;
  const impactBps = swapFeeBps === undefined
    ? undefined
    : priceImpactBps(swapAmountIn, reserveIn, swapFeeBps);
  const swapStateReady = swapsPaused.data !== undefined && !swapsPaused.error;
  const routeReadError = Boolean(swapsPaused.error);
  const removeAmountA = liquidity && reserveA !== undefined && totalSupply ? liquidity * reserveA / totalSupply : undefined;
  const removeAmountB = liquidity && reserveB !== undefined && totalSupply ? liquidity * reserveB / totalSupply : undefined;
  const expectedLiquidity = amountA && amountB
    ? totalSupply && reserveA && reserveB
      ? (amountA * totalSupply / reserveA < amountB * totalSupply / reserveB ? amountA * totalSupply / reserveA : amountB * totalSupply / reserveB)
      : (() => { const root = integerSquareRoot(amountA * amountB); return root > 1000n ? root - 1000n : 0n; })()
    : undefined;
  const pairCoreReady = Boolean(tokenA && tokenB && rawReserves && totalSupply !== undefined);
  const tokenMetadataReady = Boolean(
    tokenMetadata.data?.[0]?.result
    && tokenMetadata.data?.[1]?.result
    && tokenMetadata.data?.[2]?.result !== undefined
    && tokenMetadata.data?.[3]?.result !== undefined,
  );
  const poolReadError = Boolean(
    validation.error
    || pairMetadata.error
    || pairMetadataReadFailed
    || pairData.error
    || pairReadFailed
    || tokenMetadata.error
    || tokenReadFailed,
  );
  const poolLoading = !poolReadError && (
    validation.isPending
    || validation.data === undefined
    || (
      validation.data === true
      && (
        pairMetadata.isPending
        || pairData.isPending
        || !pairCoreReady
        || tokenMetadata.isPending
        || !tokenMetadataReady
      )
    )
  );
  const poolReady = Boolean(
    validation.data === true
    && dexRouter
    && pairCoreReady
    && tokenMetadataReady
    && !poolReadError,
  );
  const poolHasLiquidity = totalSupply !== undefined && totalSupply > 0n;

  const error = useMemo(() => {
    if (mode === "swap") {
      if (!swapAmountText) return undefined;
      if (!swapAmountIn) return "Enter a valid positive amount.";
      if (swapBalance !== undefined && swapAmountIn > swapBalance) return `${swapSymbolIn} amount exceeds wallet balance.`;
      if (swapQuote.error) return "The router quote is unavailable.";
    } else if (mode === "add") {
      if (!amountAText && !amountBText) return undefined;
      if (!amountA || !amountB) return "Enter both token amounts.";
      if (balanceA !== undefined && amountA > balanceA) return `${symbolA} amount exceeds wallet balance.`;
      if (balanceB !== undefined && amountB > balanceB) return `${symbolB} amount exceeds wallet balance.`;
    } else if (lpText) {
      if (!liquidity) return "Enter a valid LP amount.";
      if (lpBalance !== undefined && liquidity > lpBalance) return "Amount exceeds your LP balance.";
    }
    return undefined;
  }, [amountA, amountAText, amountB, amountBText, balanceA, balanceB, liquidity, lpBalance, lpText, mode, swapAmountIn, swapAmountText, swapBalance, swapQuote.error, swapSymbolIn, symbolA, symbolB]);

  function flipSwap() {
    setSwapInputIndex((current) => current === 0 ? 1 : 0);
    setSwapAmountText("");
    tx.reset();
  }

  function retryPoolReads() {
    void validation.refetch();
    if (validation.data === true) {
      void pairMetadata.refetch();
      void pairData.refetch();
      void tokenMetadata.refetch();
      if (address) void walletBalances.refetch();
      void reserveRead.refetch();
      void swapsPaused.refetch();
      void oraclePriceRead.refetch();
      void oracleFreshRead.refetch();
      void burnedLpRead.refetch();
    }
  }

  function updateAmountA(value: string) {
    setAmountAText(value);
    const parsed = parseAmount(value, decimalsA);
    if (parsed && reserveA && reserveB) setAmountBText(formatUnits(parsed * reserveB / reserveA, decimalsB));
  }

  function updateAmountB(value: string) {
    setAmountBText(value);
    const parsed = parseAmount(value, decimalsB);
    if (parsed && reserveA && reserveB) setAmountAText(formatUnits(parsed * reserveA / reserveB, decimalsA));
  }

  async function submitSwap() {
    if (!swapAmountIn || !swapAmountOut || !address || !swapTokenIn || !swapTokenOut) return;
    const hash = await tx.execute({
      approval: {
        token: swapTokenIn,
        spender: dexRouter,
        amount: swapAmountIn,
      },
      call: {
        address: dexRouter,
        abi: dexRouterAbi,
        functionName: "swapExactTokensForTokens",
        args: [
          swapAmountIn,
          minimumAfterSlippage(swapAmountOut, slippageBps),
          [swapTokenIn, swapTokenOut],
          address,
          transactionDeadline(),
        ],
      },
    });
    if (hash) {
      toast.show("Swap confirmed", `${swapSymbolIn}/${swapSymbolOut} settled.`, "success");
      setSwapAmountText("");
      void pairData.refetch(); void reserveRead.refetch(); void walletBalances.refetch(); void swapQuote.refetch();
    }
  }

  async function submitAdd() {
    if (!amountA || !amountB || !address || !tokenA || !tokenB) return;
    const hash = await tx.execute({
      approval: [
        { token: tokenA, spender: dexRouter, amount: amountA },
        { token: tokenB, spender: dexRouter, amount: amountB },
      ],
      call: {
        address: dexRouter,
        abi: dexRouterAbi,
        functionName: "addLiquidity",
        args: [{
          tokenA,
          tokenB,
          amountADesired: amountA,
          amountBDesired: amountB,
          amountAMin: minimumAfterSlippage(amountA, slippageBps),
          amountBMin: minimumAfterSlippage(amountB, slippageBps),
          minimumLiquidity: minimumAfterSlippage(expectedLiquidity ?? 0n, slippageBps),
          to: address,
          deadline: transactionDeadline(),
        }],
      },
    });
    if (hash) {
      toast.show("Liquidity added", `${displaySymbolA}/${displaySymbolB} pool updated.`, "success");
      setAmountAText(""); setAmountBText("");
      void pairData.refetch(); void reserveRead.refetch(); void walletBalances.refetch();
    }
  }

  async function submitRemove() {
    if (!liquidity || !address || !tokenA || !tokenB || removeAmountA === undefined || removeAmountB === undefined) return;
    const hash = await tx.execute({
      approval: { token: pool, spender: dexRouter, amount: liquidity },
      call: {
        address: dexRouter,
        abi: dexRouterAbi,
        functionName: "removeLiquidity",
        args: [{
          tokenA,
          tokenB,
          liquidity,
          amountAMin: minimumAfterSlippage(removeAmountA, slippageBps),
          amountBMin: minimumAfterSlippage(removeAmountB, slippageBps),
          to: address,
          deadline: transactionDeadline(),
        }],
      },
    });
    if (hash) {
      toast.show("Liquidity removed", `${displaySymbolA}/${displaySymbolB} assets returned.`, "success");
      setLpText(""); void pairData.refetch(); void reserveRead.refetch(); void walletBalances.refetch();
    }
  }

  const lpLocker = deployment.contracts.lpLocker;
  const lockAmount = parseAmount(lockAmountText);
  const lockError = useMemo(() => {
    if (lpActionMode !== "lock") return undefined;
    if (!lockAmountText) return undefined;
    if (!lockAmount) return "Enter a valid positive amount.";
    if (lpBalance !== undefined && lockAmount > lpBalance) return "Amount exceeds your LP balance.";
    if (lockMode === "timed" && !lockUnlockAt) return "Select an unlock date.";
    if (lockMode === "timed") {
      const unlockTs = Math.floor(new Date(lockUnlockAt).getTime() / 1000);
      if (!Number.isFinite(unlockTs)) return "Select a valid unlock date.";
      if (unlockTs <= currentUnixTime) return "Unlock date must be in the future.";
    }
    return undefined;
  }, [currentUnixTime, lockAmount, lockAmountText, lockMode, lockUnlockAt, lpActionMode, lpBalance]);

  async function submitLock() {
    if (lpActionMode !== "lock" || !lockAmount || !address || !lpLocker) return;
    let unlockAt: bigint | undefined;
    if (lockMode === "timed") {
      const unlockTs = Math.floor(new Date(lockUnlockAt).getTime() / 1000);
      if (!Number.isFinite(unlockTs)) return;
      unlockAt = BigInt(unlockTs);
    }
    const hash = await tx.execute({
      approval: { token: pool, spender: lpLocker, amount: lockAmount },
      call: lockMode === "permanent" ? {
        address: lpLocker,
        abi: communityLiquidityLockerAbi,
        functionName: "lockPermanent",
        args: [pool, lockAmount],
      } : {
        address: lpLocker,
        abi: communityLiquidityLockerAbi,
        functionName: "lockUntil",
        args: [pool, lockAmount, unlockAt!],
      },
    });
    if (hash) {
      toast.show("LP locked", `Your liquidity has been ${lockMode === "permanent" ? "permanently" : "temporarily"} locked.`, "success");
      setLockAmountText(""); setLockUnlockAt("");
      void walletBalances.refetch();
      void lockedLpRead.refetch();
      void ownerLockIdsRead.refetch();
      void locksRead.refetch();
    }
  }

  const burnAmount = parseAmount(burnAmountText);
  const burnError = useMemo(() => {
    if (lpActionMode !== "burn") return undefined;
    if (!burnAmountText) return undefined;
    if (!burnAmount) return "Enter a valid positive amount.";
    if (lpBalance !== undefined && burnAmount > lpBalance) return "Amount exceeds your LP balance.";
    return undefined;
  }, [burnAmount, burnAmountText, lpActionMode, lpBalance]);

  async function submitBurn() {
    if (lpActionMode !== "burn" || !burnAmount || !address) return;
    const hash = await tx.execute({
      call: {
        address: pool,
        abi: erc20Abi,
        functionName: "transfer",
        args: [LP_DEAD_ADDRESS, burnAmount],
      },
    });
    if (hash) {
      toast.show("LP burned", "Liquidity sent to the dead address permanently.", "success");
      setBurnAmountText("");
      void walletBalances.refetch();
      void burnedLpRead.refetch();
    }
  }

  async function submitWithdraw(lockId: bigint) {
    if (!address || !deployment.contracts.lpLocker) return;
    const hash = await tx.execute({
      call: {
        address: deployment.contracts.lpLocker,
        abi: communityLiquidityLockerAbi,
        functionName: "withdraw",
        args: [lockId],
      },
    });
    if (hash) {
      toast.show("LP withdrawn", "Your locked liquidity has been returned.", "success");
      void walletBalances.refetch();
      void lockedLpRead.refetch();
      void locksRead.refetch();
    }
  }

  if (!deployment.contracts.dexFactory || !dexRouter) return <NotDeployed feature="DEX" />;
  if (validation.data === false) return <NotDeployed feature="Unknown DEX pool" />;
  return (
    <>
      <header className="fi-trade-header">
        <Link className="fi-icon-button fi-trade-back" href={fiPath("/pools")} aria-label="Back to pools" title="Back to pools">
          <ArrowLeft size={19} weight="bold" aria-hidden="true" />
        </Link>
        <div className="fi-trade-identity">
          <TokenPairLogos
            token0={{ symbol: displaySymbolA, imageUrl: displayImageA }}
            token1={{ symbol: displaySymbolB, imageUrl: displayImageB }}
            size="lg"
          />
          <h1>{displaySymbolA}<span>/</span>{displaySymbolB}</h1>
        </div>
        <dl className="fi-trade-quote">
          <div><dt>Price</dt><dd>{displayMarketPrice(marketPriceNusd)}</dd></div>
          <div><dt>TVL</dt><dd>{tvlNusd === undefined ? "--" : `$${tvlNusd.toLocaleString("en-US", { maximumFractionDigits: 2 })}`}</dd></div>
        </dl>
      </header>
      <div className="fi-workspace-grid fi-trade-workspace">
        <div className="fi-main-stack">
          <LazyMarketChart
            pair={pool.toLowerCase()}
            label={`${displaySymbolA} price · ${displaySymbolB}`}
            token0={{ symbol: displaySymbolA, imageUrl: displayImageA }}
            token1={{ symbol: displaySymbolB, imageUrl: displayImageB }}
          />
          <RecentActivity pair={pool.toLowerCase()} />
          <details className="fi-pool-details">
            <summary>Pool details</summary>
            <dl>
              <div><dt>{symbolA} reserve</dt><dd>{formatAmount(reserveA ?? rawReserveA, decimalsA)}</dd></div>
              <div><dt>{symbolB} reserve</dt><dd>{formatAmount(reserveB ?? rawReserveB, decimalsB)}</dd></div>
              <div><dt>Total LP</dt><dd>{formatAmount(totalSupply)}</dd></div>
              <div><dt>Your share</dt><dd>{percentageShare(lpBalance, totalSupply)}</dd></div>
              {lpBalance !== undefined && lpBalance > 0n ? (
                <div><dt>Your LP</dt><dd>{formatAmount(lpBalance)}</dd></div>
              ) : null}
              {lockedLp !== undefined && lockedLp > 0n ? (
                <div><dt>Locked LP</dt><dd>{formatAmount(lockedLp)}</dd></div>
              ) : null}
              {burnedLp !== undefined && burnedLp > 0n ? (
                <div><dt>Burned LP</dt><dd>{formatAmount(burnedLp)}</dd></div>
              ) : null}
            </dl>
          </details>
        </div>
        <aside className="fi-panel fi-sticky-panel fi-trade-panel fi-primary-action">
          {poolLoading ? (
            <div className="fi-inline-state" role="status">
              <HourglassSimple size={17} weight="bold" aria-hidden="true" />
              <div><strong>Loading pool</strong></div>
            </div>
          ) : null}
          {poolReadError ? (
            <div className="fi-inline-state fi-inline-danger" role="alert">
              <Warning size={17} weight="bold" aria-hidden="true" />
              <div><strong>Pool unavailable</strong></div>
              <button type="button" className="fi-inline-retry" onClick={retryPoolReads} aria-label="Retry pool data" title="Retry pool data">
                <ArrowClockwise size={15} weight="bold" aria-hidden="true" />
              </button>
            </div>
          ) : null}
          {poolReady && !poolHasLiquidity && mode !== "add" ? (
            <div className="fi-inline-state fi-inline-warning" role="status"><div><strong>No liquidity</strong></div></div>
          ) : null}
          {mode === "swap" && routeReadError ? (
            <div className="fi-inline-state fi-inline-danger" role="alert">
              <Warning size={17} weight="bold" aria-hidden="true" />
              <div><strong>Route unavailable</strong></div>
              <button type="button" className="fi-inline-retry" onClick={() => void swapsPaused.refetch()} aria-label="Retry route data" title="Retry route data">
                <ArrowClockwise size={15} weight="bold" aria-hidden="true" />
              </button>
            </div>
          ) : null}
          {swapsPaused.data ? <div className="fi-inline-state fi-inline-danger" role="alert"><div><strong>Swaps paused</strong></div></div> : null}
          <div className="fi-segmented" role="group" aria-label="Pool action">
            <button type="button" className={mode === "swap" ? "active positive" : ""} aria-pressed={mode === "swap"} onClick={() => { setMode("swap"); tx.reset(); }}>Swap</button>
            <button type="button" className={mode === "add" ? "active positive" : ""} aria-pressed={mode === "add"} onClick={() => { setMode("add"); tx.reset(); }}>Add</button>
            <button type="button" className={mode === "remove" ? "active" : ""} aria-pressed={mode === "remove"} onClick={() => { setMode("remove"); tx.reset(); }}>Remove</button>
          </div>
          <div className="fi-form">
            {mode === "swap" ? <>
              <AmountField
                id="dynamic-swap-amount-in"
                label="Pay"
                asset={swapSymbolIn}
                imageUrl={swapImageIn}
                value={swapAmountText}
                balance={formatAmount(swapBalance, swapDecimalsIn)}
                onChange={setSwapAmountText}
                onMax={swapBalance && swapBalance > 0n ? () => setSwapAmountText(formatUnits(swapBalance, swapDecimalsIn)) : undefined}
                error={error}
              />
              <button type="button" className="fi-icon-button fi-swap-arrow" onClick={flipSwap} aria-label="Reverse swap direction">
                <ArrowsDownUp size={18} weight="bold" aria-hidden="true" />
              </button>
              <AmountField
                id="dynamic-swap-amount-out"
                label="Receive"
                asset={swapSymbolOut}
                imageUrl={swapImageOut}
                value={swapAmountOut ? formatUnits(swapAmountOut, swapDecimalsOut) : ""}
                helper={swapQuote.isFetching ? "Refreshing quote" : undefined}
                readOnly
              />
              <dl className="fi-form-details">
                <div><dt>Price impact</dt><dd data-tone={impactBps === undefined ? undefined : impactBps >= 500n ? "danger" : impactBps >= 100n ? "warning" : "positive"}>{displayPriceImpact(impactBps)}</dd></div>
                <div><dt>Min received</dt><dd>{formatAmount(swapAmountOut ? minimumAfterSlippage(swapAmountOut, slippageBps) : undefined, swapDecimalsOut)} {swapSymbolOut}</dd></div>
                <div><dt>Fee</dt><dd>{formatFeeBps(feeSchedule ? feeSchedule.lpFeeBps + feeSchedule.protocolFeeBps : undefined)}</dd></div>
              </dl>
            </> : mode === "add" ? <>
              <AmountField id="dynamic-pool-amount-a" label={symbolA} asset={symbolA} imageUrl={imageA} value={amountAText} balance={formatAmount(balanceA, decimalsA)} onChange={updateAmountA} onMax={balanceA && balanceA > 0n ? () => updateAmountA(formatUnits(balanceA, decimalsA)) : undefined} error={error?.startsWith(symbolA) ? error : undefined} />
              <span className="fi-liquidity-plus" aria-hidden="true">+</span>
              <AmountField id="dynamic-pool-amount-b" label={symbolB} asset={symbolB} imageUrl={imageB} value={amountBText} balance={formatAmount(balanceB, decimalsB)} onChange={updateAmountB} onMax={balanceB && balanceB > 0n ? () => updateAmountB(formatUnits(balanceB, decimalsB)) : undefined} error={error?.startsWith(symbolB) || error?.startsWith("Enter") ? error : undefined} />
            </> : <>
              <AmountField id="dynamic-pool-lp-amount" label="LP amount" asset="LP" value={lpText} balance={formatAmount(lpBalance)} onChange={setLpText} onMax={lpBalance && lpBalance > 0n ? () => setLpText(formatUnits(lpBalance, 18)) : undefined} error={error} />
              <dl className="fi-form-details">
                <div><dt>Expected {symbolA}</dt><dd>{formatAmount(removeAmountA, decimalsA)}</dd></div>
                <div><dt>Expected {symbolB}</dt><dd>{formatAmount(removeAmountB, decimalsB)}</dd></div>
              </dl>
            </>}
            <details className="fi-settings-details">
              <summary><span>Transaction settings</span><strong>{Number(slippageBps) / 100}% slippage</strong></summary>
              <SlippageControl value={slippageBps} onChange={setSlippageBps} />
            </details>
            {!isConnected ? <ConnectWalletButton /> : (
              <button
                type="button"
                className={`fi-button fi-button-block ${mode === "remove" ? "fi-button-muted" : "fi-button-primary"}`}
                disabled={!poolReady || Boolean(error) || tx.pending || (mode === "swap" ? !poolHasLiquidity || !swapStateReady || Boolean(swapsPaused.data) || swapQuote.isFetching || !swapAmountIn || !swapAmountOut : mode === "add" ? !amountA || !amountB || !expectedLiquidity : !poolHasLiquidity || !liquidity || removeAmountA === undefined || removeAmountB === undefined)}
                onClick={() => void (mode === "swap" ? submitSwap() : mode === "add" ? submitAdd() : submitRemove())}
              >
                {!poolReady ? poolLoading ? "Loading pool" : "Pool unavailable" : tx.pending ? "Processing" : mode === "swap" ? !poolHasLiquidity ? "No liquidity" : routeReadError ? "Route unavailable" : !swapStateReady ? "Checking route" : swapsPaused.data ? "Swaps paused" : "Swap" : mode === "add" ? "Add liquidity" : !poolHasLiquidity ? "No liquidity" : "Remove liquidity"}
              </button>
            )}
            <TransactionStatus phase={tx.phase} message={tx.message} hash={tx.hash} />
          </div>
          {poolReady && (lpBalance !== undefined && lpBalance > 0n || hasLockedLp || hasBurnedLp) ? (
            <details className="fi-settings-details fi-lock-lp-details">
              <summary>
                <span>LP security</span>
                <strong>{lpSecurityTotal > 0n ? `${formatLpDetailAmount(lpSecuritySecured)} / ${formatLpDetailAmount(lpSecurityTotal)}` : "--"}</strong>
              </summary>
              <div className="fi-disclosure-body">
                {lpSecurityTotal > 0n ? (
                  <span
                    className="fi-lp-security"
                    data-open={lpSecurityOpen || undefined}
                    tabIndex={0}
                    role="img"
                    aria-describedby={lpSecurityTooltipId}
                    aria-label={`LP security: ${formatLpDetailPercent(lpSecurityLocked, lpSecurityTotal)} locked, ${formatLpDetailPercent(lpSecurityBurned, lpSecurityTotal)} burned, ${formatLpDetailPercent(lpSecurityUnlocked, lpSecurityTotal)} unlocked`}
                    onClick={(event) => {
                      event.preventDefault();
                      setLpSecurityOpen((open) => !open);
                    }}
                    onKeyDown={(event) => {
                      if (event.key !== "Enter" && event.key !== " ") return;
                      event.preventDefault();
                      setLpSecurityOpen((open) => !open);
                    }}
                    onBlur={() => setLpSecurityOpen(false)}
                  >
                    <span className="fi-lp-security-track" aria-hidden="true">
                      {lpSecurityLocked > 0n ? <i data-state="locked" style={{ width: `${lpSecurityLockedPercent}%` }} /> : null}
                      {lpSecurityBurned > 0n ? <i data-state="burned" style={{ width: `${lpSecurityBurnedPercent}%` }} /> : null}
                      {lpSecurityUnlocked > 0n ? <i data-state="unlocked" style={{ width: `${lpSecurityUnlockedPercent}%` }} /> : null}
                    </span>
                    <span className="fi-lp-security-tooltip" id={lpSecurityTooltipId} role="tooltip">
                      <span><i data-state="locked" /><em>Locked</em><strong>{formatLpDetailAmount(lpSecurityLocked)} LP · {formatLpDetailPercent(lpSecurityLocked, lpSecurityTotal)}</strong></span>
                      <span><i data-state="burned" /><em>Burned</em><strong>{formatLpDetailAmount(lpSecurityBurned)} LP · {formatLpDetailPercent(lpSecurityBurned, lpSecurityTotal)}</strong></span>
                      <span><i data-state="unlocked" /><em>Unlocked</em><strong>{formatLpDetailAmount(lpSecurityUnlocked)} LP · {formatLpDetailPercent(lpSecurityUnlocked, lpSecurityTotal)}</strong></span>
                      <span className="fi-lp-security-total"><em>Total</em><strong>{formatLpDetailAmount(lpSecurityTotal)} LP</strong></span>
                    </span>
                  </span>
                ) : (
                  <p className="fi-hint">LP supply is not yet indexed.</p>
                )}
                {permanentLockedLp > 0n || timedLockedLp > 0n || earliestUnlockAt !== undefined ? (
                  <dl className="fi-form-details fi-lp-security-summary">
                    {permanentLockedLp > 0n ? <div><dt>Your permanent LP</dt><dd>{formatAmount(permanentLockedLp)}</dd></div> : null}
                    {timedLockedLp > 0n ? <div><dt>Your timed LP</dt><dd>{formatAmount(timedLockedLp)}</dd></div> : null}
                    {earliestUnlockAt !== undefined ? <div><dt>Your next unlock</dt><dd>{displayUnlockTime(earliestUnlockAt)}</dd></div> : null}
                  </dl>
                ) : null}
                {(ownerLockIdsRead.isPending || locksRead.isPending) && hasLockedLp && address ? <p className="fi-hint">Loading your lock schedule...</p> : null}
                {ownerLockIdsRead.isError || locksRead.isError ? <p className="fi-hint">Lock amount is verified on-chain, but your unlock schedule is temporarily unavailable.</p> : null}
                {withdrawableLocks.map((lock) => (
                  <button
                    type="button"
                    className="fi-button fi-button-block fi-button-primary"
                    disabled={tx.pending}
                    onClick={() => void submitWithdraw(lock.id)}
                    key={lock.id.toString()}
                  >
                    {tx.pending ? "Processing" : `Withdraw ${formatAmount(lock.amount)} LP`}
                  </button>
                ))}
                {lpBalance !== undefined && lpBalance > 0n ? <>
                  <div className="fi-segmented" role="group" aria-label="LP action">
                    <button type="button" className={lpActionMode === "lock" ? "active positive" : ""} aria-pressed={lpActionMode === "lock"} onClick={() => { setLpActionMode("lock"); tx.reset(); }}>Lock</button>
                    <button type="button" className={lpActionMode === "burn" ? "active" : ""} aria-pressed={lpActionMode === "burn"} onClick={() => { setLpActionMode("burn"); tx.reset(); }}>Burn</button>
                  </div>
                  {lpActionMode === "lock" ? <>
                    <AmountField
                      id="dynamic-lock-lp-amount"
                      label="LP amount"
                      asset="LP"
                      value={lockAmountText}
                      balance={formatAmount(lpBalance)}
                      onChange={setLockAmountText}
                      onMax={() => setLockAmountText(formatUnits(lpBalance, 18))}
                      error={lockError}
                    />
                    <div className="fi-segmented" role="group" aria-label="Lock type">
                      <button type="button" className={lockMode === "permanent" ? "active positive" : ""} aria-pressed={lockMode === "permanent"} onClick={() => setLockMode("permanent")}>Permanent</button>
                      <button type="button" className={lockMode === "timed" ? "active" : ""} aria-pressed={lockMode === "timed"} onClick={() => setLockMode("timed")}>Timed</button>
                    </div>
                    {lockMode === "timed" ? (
                      <label className="fi-field">
                        <span className="fi-field-label">Unlock date</span>
                        <input
                          type="datetime-local"
                          value={lockUnlockAt}
                          onChange={(event) => setLockUnlockAt(event.target.value)}
                          className="fi-input"
                        />
                      </label>
                    ) : null}
                    {!isConnected ? <ConnectWalletButton /> : (
                      <button
                        type="button"
                        className="fi-button fi-button-block fi-button-primary"
                        disabled={Boolean(lockError) || tx.pending || !lockAmount}
                        onClick={() => void submitLock()}
                      >
                        {tx.pending ? "Processing" : lockMode === "permanent" ? "Lock permanently" : "Lock until date"}
                      </button>
                    )}
                  </> : <>
                    <AmountField
                      id="dynamic-burn-lp-amount"
                      label="LP amount"
                      asset="LP"
                      value={burnAmountText}
                      balance={formatAmount(lpBalance)}
                      onChange={setBurnAmountText}
                      onMax={() => setBurnAmountText(formatUnits(lpBalance, 18))}
                      error={burnError}
                    />
                    <p className="fi-hint">Burning sends LP to the dead address permanently.</p>
                    {!isConnected ? <ConnectWalletButton /> : (
                      <button
                        type="button"
                        className="fi-button fi-button-block fi-button-muted"
                        disabled={Boolean(burnError) || tx.pending || !burnAmount}
                        onClick={() => void submitBurn()}
                      >
                        {tx.pending ? "Processing" : "Burn to dead address"}
                      </button>
                    )}
                  </>}
                </> : null}
                <TransactionStatus phase={tx.phase} message={tx.message} hash={tx.hash} />
              </div>
            </details>
          ) : null}
        </aside>
      </div>
    </>
  );
}
