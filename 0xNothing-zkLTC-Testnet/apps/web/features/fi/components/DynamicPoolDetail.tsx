"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { ArrowClockwise, ArrowLeft, ArrowsDownUp, HourglassSimple, Warning } from "@phosphor-icons/react";
import { useAccount, useReadContract, useReadContracts } from "wagmi";
import { formatUnits, zeroAddress, type Address } from "viem";
import { AmountField } from "@fi/components/AmountField";
import { MarketChart } from "@fi/components/MarketChart";
import { RecentActivity } from "@fi/components/RecentActivity";
import { SlippageControl } from "@fi/components/SlippageControl";
import { TokenPairLogos, tokenImageUrl } from "@fi/components/TokenLogo";
import { NotDeployed, TransactionStatus } from "@fi/components/UiStates";
import { useToast } from "@fi/components/Toast";
import { deployment } from "@fi/config/deployment";
import { fiPath } from "@fi/config/paths";
import { diaOracleAdapterAbi } from "@fi/lib/abis/dia";
import { dexFactoryAbi, dexPoolAbi, dexRouterAbi } from "@fi/lib/abis/dex";
import { erc20Abi } from "@fi/lib/abis/erc20";
import { canonicalOracleMarketForIdentifier } from "@fi/lib/canonicalMarkets";
import { formatAmount, minimumAfterSlippage, parseAmount, percentageShare, transactionDeadline } from "@fi/lib/format";
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

const tokenImageAbi = [{
  type: "function", name: "imageURI", stateMutability: "view",
  inputs: [], outputs: [{ name: "", type: "string" }],
}] as const;

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

  const validation = useReadContract({
    address: deployment.contracts.dexFactory,
    abi: dexFactoryAbi,
    functionName: "isPair",
    args: [pool],
    query: { enabled: Boolean(deployment.contracts.dexFactory), staleTime: 60_000 },
  });
  const pairData = useReadContracts({
    contracts: [
      { address: pool, abi: dexPoolAbi, functionName: "token0" },
      { address: pool, abi: dexPoolAbi, functionName: "token1" },
      { address: pool, abi: dexPoolAbi, functionName: "getReserves" },
      { address: pool, abi: dexPoolAbi, functionName: "totalSupply" },
      { address: pool, abi: dexPoolAbi, functionName: "balanceOf", args: [address ?? zeroAddress] },
    ] as const,
    query: { enabled: validation.data === true, refetchInterval: 12_000 },
  });
  const poolToken0 = pairData.data?.[0]?.result as Address | undefined;
  const poolToken1 = pairData.data?.[1]?.result as Address | undefined;
  const rawReserves = pairData.data?.[2]?.result as readonly [bigint, bigint, number] | undefined;
  const totalSupply = pairData.data?.[3]?.result as bigint | undefined;
  const lpBalance = pairData.data?.[4]?.result as bigint | undefined;
  const pairReadFailed = pairData.data?.slice(0, 4).some((result) => result.status === "failure") ?? false;
  const nusdAddress = deployment.contracts.nusd?.toLowerCase();
  const quoteFirst = Boolean(poolToken0 && nusdAddress && poolToken0.toLowerCase() === nusdAddress);
  const tokenA = quoteFirst ? poolToken1 : poolToken0;
  const tokenB = quoteFirst ? poolToken0 : poolToken1;
  const rawReserveA = quoteFirst ? rawReserves?.[1] : rawReserves?.[0];
  const rawReserveB = quoteFirst ? rawReserves?.[0] : rawReserves?.[1];
  const tokenData = useReadContracts({
    contracts: tokenA && tokenB ? [
      { address: tokenA, abi: erc20Abi, functionName: "symbol" },
      { address: tokenB, abi: erc20Abi, functionName: "symbol" },
      { address: tokenA, abi: erc20Abi, functionName: "decimals" },
      { address: tokenB, abi: erc20Abi, functionName: "decimals" },
      { address: tokenA, abi: erc20Abi, functionName: "balanceOf", args: [address ?? zeroAddress] },
      { address: tokenB, abi: erc20Abi, functionName: "balanceOf", args: [address ?? zeroAddress] },
      { address: tokenA, abi: tokenImageAbi, functionName: "imageURI" },
      { address: tokenB, abi: tokenImageAbi, functionName: "imageURI" },
    ] as const : [],
    query: { enabled: Boolean(tokenA && tokenB), refetchInterval: 12_000 },
  });
  const symbolA = displaySymbol(tokenData.data?.[0]?.result as string | undefined);
  const symbolB = displaySymbol(tokenData.data?.[1]?.result as string | undefined);
  const decimalsA = (tokenData.data?.[2]?.result as number | undefined) ?? 18;
  const decimalsB = (tokenData.data?.[3]?.result as number | undefined) ?? 18;
  const amountA = parseAmount(amountAText, decimalsA);
  const amountB = parseAmount(amountBText, decimalsB);
  const liquidity = parseAmount(lpText);
  const balanceA = tokenData.data?.[4]?.result as bigint | undefined;
  const balanceB = tokenData.data?.[5]?.result as bigint | undefined;
  const tokenReadFailed = tokenData.data?.slice(0, 4).some((result) => result.status === "failure") ?? false;
  const imageA = tokenImageUrl(tokenData.data?.[6]?.result as string | undefined);
  const imageB = tokenImageUrl(tokenData.data?.[7]?.result as string | undefined);
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
    query: { enabled: Boolean(dexRouter && validation.data && tokenA && tokenB), refetchInterval: 12_000 },
  });
  const reserveA = reserveRead.data?.[0] ?? rawReserveA;
  const reserveB = reserveRead.data?.[1] ?? rawReserveB;
  const tokenAIsNusd = Boolean(tokenA && nusdAddress && tokenA.toLowerCase() === nusdAddress);
  const tokenBIsNusd = Boolean(tokenB && nusdAddress && tokenB.toLowerCase() === nusdAddress);
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
    query: { enabled: Boolean(canonicalMarket?.oracle), refetchInterval: 12_000 },
  });
  const oracleFreshRead = useReadContract({
    address: canonicalMarket?.oracle,
    abi: diaOracleAdapterAbi,
    functionName: "isFresh",
    query: { enabled: Boolean(canonicalMarket?.oracle), refetchInterval: 12_000 },
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
      refetchInterval: 12_000,
    },
  });
  const swapsPaused = useReadContract({
    address: deployment.contracts.dexFactory,
    abi: dexFactoryAbi,
    functionName: "swapsPaused",
    query: { enabled: Boolean(deployment.contracts.dexFactory), refetchInterval: 10_000 },
  });
  const swapAmountOut = swapQuote.data?.at(-1);
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
    tokenData.data?.[0]?.result
    && tokenData.data?.[1]?.result
    && tokenData.data?.[2]?.result !== undefined
    && tokenData.data?.[3]?.result !== undefined,
  );
  const poolReadError = Boolean(validation.error || pairData.error || pairReadFailed || tokenData.error || tokenReadFailed);
  const poolLoading = !poolReadError && (
    validation.isPending
    || validation.data === undefined
    || (validation.data === true && (pairData.isPending || !pairCoreReady || tokenData.isPending || !tokenMetadataReady))
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
      void pairData.refetch();
      void tokenData.refetch();
      void reserveRead.refetch();
      void swapsPaused.refetch();
      void oraclePriceRead.refetch();
      void oracleFreshRead.refetch();
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
      void pairData.refetch(); void tokenData.refetch(); void reserveRead.refetch(); void swapQuote.refetch();
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
      toast.show("Liquidity added", `${symbolA}/${symbolB} pool updated.`, "success");
      setAmountAText(""); setAmountBText("");
      void pairData.refetch(); void tokenData.refetch();
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
      toast.show("Liquidity removed", `${symbolA}/${symbolB} assets returned.`, "success");
      setLpText(""); void pairData.refetch();
    }
  }

  if (!deployment.contracts.dexFactory || !dexRouter) return <NotDeployed feature="DEX" />;
  if (validation.data === false) return <NotDeployed feature="Unknown DEX pool" />;
  return (
    <>
      <header className="fi-trade-header">
        <Link className="fi-icon-button fi-trade-back" href={fiPath("/")} aria-label="Back to markets" title="Back to markets">
          <ArrowLeft size={19} weight="bold" aria-hidden="true" />
        </Link>
        <div className="fi-trade-identity">
          <TokenPairLogos
            token0={{ symbol: symbolA, imageUrl: imageA }}
            token1={{ symbol: symbolB, imageUrl: imageB }}
            size="lg"
          />
          <h1>{symbolA}<span>/</span>{symbolB}</h1>
        </div>
        <dl className="fi-trade-quote">
          <div><dt>Price</dt><dd>{displayMarketPrice(marketPriceNusd)}</dd></div>
          <div><dt>TVL</dt><dd>{tvlNusd === undefined ? "--" : `$${tvlNusd.toLocaleString("en-US", { maximumFractionDigits: 2 })}`}</dd></div>
        </dl>
      </header>
      <div className="fi-workspace-grid fi-trade-workspace">
        <div className="fi-main-stack">
          <MarketChart
            pair={pool.toLowerCase()}
            label={`${symbolA}/${symbolB}`}
            token0={{ symbol: symbolA, imageUrl: imageA }}
            token1={{ symbol: symbolB, imageUrl: imageB }}
          />
          <RecentActivity pair={pool.toLowerCase()} />
          <details className="fi-pool-details">
            <summary>Pool details</summary>
            <dl>
              <div><dt>{symbolA} reserve</dt><dd>{formatAmount(reserveA ?? rawReserveA, decimalsA)}</dd></div>
              <div><dt>{symbolB} reserve</dt><dd>{formatAmount(reserveB ?? rawReserveB, decimalsB)}</dd></div>
              <div><dt>Total LP</dt><dd>{formatAmount(totalSupply)}</dd></div>
              <div><dt>Your share</dt><dd>{percentageShare(lpBalance, totalSupply)}</dd></div>
            </dl>
          </details>
        </div>
        <aside className="fi-panel fi-sticky-panel fi-trade-panel">
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
          <div className="fi-segmented" aria-label="Pool action">
            <button type="button" className={mode === "swap" ? "active positive" : ""} onClick={() => { setMode("swap"); tx.reset(); }}>Swap</button>
            <button type="button" className={mode === "add" ? "active positive" : ""} onClick={() => { setMode("add"); tx.reset(); }}>Add</button>
            <button type="button" className={mode === "remove" ? "active danger" : ""} onClick={() => { setMode("remove"); tx.reset(); }}>Remove</button>
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
                <div><dt>Min received</dt><dd>{formatAmount(swapAmountOut ? minimumAfterSlippage(swapAmountOut, slippageBps) : undefined, swapDecimalsOut)} {swapSymbolOut}</dd></div>
                <div><dt>Fee</dt><dd>{formatFeeBps(feeSchedule ? feeSchedule.lpFeeBps + feeSchedule.protocolFeeBps : undefined)}</dd></div>
              </dl>
            </> : mode === "add" ? <>
              <AmountField id="dynamic-pool-amount-a" label={symbolA} asset={symbolA} imageUrl={imageA} value={amountAText} balance={formatAmount(balanceA, decimalsA)} onChange={updateAmountA} onMax={balanceA && balanceA > 0n ? () => updateAmountA(formatUnits(balanceA, decimalsA)) : undefined} error={error?.startsWith(symbolA) ? error : undefined} />
              <AmountField id="dynamic-pool-amount-b" label={symbolB} asset={symbolB} imageUrl={imageB} value={amountBText} balance={formatAmount(balanceB, decimalsB)} onChange={updateAmountB} onMax={balanceB && balanceB > 0n ? () => updateAmountB(formatUnits(balanceB, decimalsB)) : undefined} error={error?.startsWith(symbolB) || error?.startsWith("Enter") ? error : undefined} />
            </> : <>
              <AmountField id="dynamic-pool-lp-amount" label="LP amount" asset="LP" value={lpText} balance={formatAmount(lpBalance)} onChange={setLpText} onMax={lpBalance && lpBalance > 0n ? () => setLpText(formatUnits(lpBalance, 18)) : undefined} error={error} />
              <dl className="fi-form-details">
                <div><dt>Expected {symbolA}</dt><dd>{formatAmount(removeAmountA, decimalsA)}</dd></div>
                <div><dt>Expected {symbolB}</dt><dd>{formatAmount(removeAmountB, decimalsB)}</dd></div>
              </dl>
            </>}
            <SlippageControl value={slippageBps} onChange={setSlippageBps} />
            <button
              type="button"
              className={`fi-button fi-button-block ${mode === "remove" ? "fi-button-danger" : "fi-button-primary"}`}
              disabled={!poolReady || !isConnected || Boolean(error) || tx.pending || (mode === "swap" ? !poolHasLiquidity || !swapStateReady || Boolean(swapsPaused.data) || swapQuote.isFetching || !swapAmountIn || !swapAmountOut : mode === "add" ? !amountA || !amountB || !expectedLiquidity : !poolHasLiquidity || !liquidity || removeAmountA === undefined || removeAmountB === undefined)}
              onClick={() => void (mode === "swap" ? submitSwap() : mode === "add" ? submitAdd() : submitRemove())}
            >
              {!poolReady ? poolLoading ? "Loading pool" : "Pool unavailable" : !isConnected ? "Connect wallet" : tx.pending ? "Processing" : mode === "swap" ? !poolHasLiquidity ? "No liquidity" : routeReadError ? "Route unavailable" : !swapStateReady ? "Checking route" : swapsPaused.data ? "Swaps paused" : "Swap" : mode === "add" ? "Add liquidity" : !poolHasLiquidity ? "No liquidity" : "Remove liquidity"}
            </button>
            <TransactionStatus phase={tx.phase} message={tx.message} hash={tx.hash} />
          </div>
        </aside>
      </div>
    </>
  );
}
