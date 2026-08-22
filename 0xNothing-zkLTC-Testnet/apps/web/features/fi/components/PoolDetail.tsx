"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { useAccount, useReadContract, useReadContracts } from "wagmi";
import { formatUnits, zeroAddress } from "viem";
import { AmountField } from "@fi/components/AmountField";
import { ConnectWalletButton } from "@fi/components/ConnectWalletButton";
import { SlippageControl } from "@fi/components/SlippageControl";
import { NotDeployed, PanelHeading, TransactionStatus } from "@fi/components/UiStates";
import { useToast } from "@fi/components/Toast";
import { assetForPool, assets, pairSlug, type AssetSymbol } from "@fi/config/assets";
import { deployment } from "@fi/config/deployment";
import { fiPath } from "@fi/config/paths";
import { dexFactoryAbi, dexPoolAbi, dexRouterAbi } from "@fi/lib/abis/dex";
import { farmGaugeAbi } from "@fi/lib/abis/farm";
import { formatAmount, minimumAfterSlippage, parseAmount, percentageShare, transactionDeadline } from "@fi/lib/format";
import { useAssetBalance } from "@fi/lib/hooks/useAssetBalance";
import { useActiveDexRouter } from "@fi/lib/hooks/useActiveDexRouter";
import { useProtocolTransaction } from "@fi/lib/hooks/useProtocolTransaction";
import { LazyMarketChart } from "@fi/components/LazyMarketChart";
import { RecentActivity } from "@fi/components/RecentActivity";

const NATIVE_GAS_RESERVE_WEI = 10_000_000_000_000_000n;

function integerSquareRoot(value: bigint): bigint {
  if (value < 2n) return value;
  let current = value;
  let next = (current + value / current) / 2n;
  while (next < current) { current = next; next = (current + value / current) / 2n; }
  return current;
}

export function PoolDetail({
  pair,
  fromEarn = false,
  initialMode = "add",
}: {
  pair: readonly [AssetSymbol, AssetSymbol];
  fromEarn?: boolean;
  initialMode?: "add" | "remove";
}) {
  const tokenA = pair[0] === "NUSD" ? pair[0] : pair[1] === "NUSD" ? pair[1] : pair[0];
  const tokenB = pair[0] === tokenA ? pair[1] : pair[0];
  const marketToken = tokenA === "NUSD" ? tokenB : tokenA;
  const pairLabel = tokenA === "NUSD" ? `${tokenB}/${tokenA}` : `${tokenA}/${tokenB}`;
  const routePairSlug = pairSlug(pair[0], pair[1]);
  const addressA = assetForPool(tokenA);
  const addressB = assetForPool(tokenB);
  const { address, isConnected } = useAccount();
  const toast = useToast();
  const dexRouter = useActiveDexRouter();
  const [mode, setMode] = useState<"add" | "remove">(initialMode);
  const [amountAText, setAmountAText] = useState("");
  const [amountBText, setAmountBText] = useState("");
  const [lpText, setLpText] = useState("");
  const [slippageBps, setSlippageBps] = useState(50n);
  const amountA = parseAmount(amountAText);
  const amountB = parseAmount(amountBText);
  const liquidity = parseAmount(lpText);
  const balanceA = useAssetBalance(tokenA);
  const balanceB = useAssetBalance(tokenB);
  const availableA = assets[tokenA].native && balanceA.data !== undefined
    ? balanceA.data > NATIVE_GAS_RESERVE_WEI ? balanceA.data - NATIVE_GAS_RESERVE_WEI : 0n
    : balanceA.data;
  const availableB = assets[tokenB].native && balanceB.data !== undefined
    ? balanceB.data > NATIVE_GAS_RESERVE_WEI ? balanceB.data - NATIVE_GAS_RESERVE_WEI : 0n
    : balanceB.data;
  const tx = useProtocolTransaction();
  const poolRead = useReadContract({
    address: deployment.contracts.dexFactory,
    abi: dexFactoryAbi,
    functionName: "getPair",
    args: addressA && addressB ? [addressA, addressB] : undefined,
    query: {
      enabled: Boolean(deployment.contracts.dexFactory && addressA && addressB),
      refetchInterval: (query) => query.state.data && query.state.data !== zeroAddress ? false : 5_000,
    },
  });
  const pool = poolRead.data && poolRead.data !== zeroAddress ? poolRead.data : undefined;
  const poolStats = useReadContracts({
    contracts: pool ? [
      { address: pool, abi: dexPoolAbi, functionName: "totalSupply" },
    ] as const : [],
    query: { enabled: Boolean(pool) },
  });
  const totalSupply = poolStats.data?.[0]?.result as bigint | undefined;
  const lpBalanceRead = useReadContract({
    address: pool,
    abi: dexPoolAbi,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    query: { enabled: Boolean(pool && address) },
  });
  const lpBalance = lpBalanceRead.data as bigint | undefined;
  const gauge = marketToken === "zkLTC"
    ? deployment.contracts.wzkLtcNusdGauge
    : marketToken === "nBTC"
      ? deployment.contracts.nbtcNusdGauge
      : marketToken === "nETH"
        ? deployment.contracts.nethNusdGauge
        : undefined;
  const stakedLpRead = useReadContract({
    address: gauge,
    abi: farmGaugeAbi,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    query: { enabled: Boolean(gauge && address) },
  });
  const stakedLp = stakedLpRead.data as bigint | undefined;
  const ownedLp = address && (lpBalance !== undefined || stakedLp !== undefined)
    ? (lpBalance ?? 0n) + (stakedLp ?? 0n)
    : undefined;
  const reserveRead = useReadContract({
    address: dexRouter,
    abi: dexRouterAbi,
    functionName: "getReserves",
    args: addressA && addressB ? [addressA, addressB] : undefined,
    query: { enabled: Boolean(dexRouter && pool && addressA && addressB) },
  });
  const reserveA = reserveRead.data?.[0];
  const reserveB = reserveRead.data?.[1];
  const removeAmountA = liquidity && reserveA !== undefined && totalSupply ? liquidity * reserveA / totalSupply : undefined;
  const removeAmountB = liquidity && reserveB !== undefined && totalSupply ? liquidity * reserveB / totalSupply : undefined;
  const expectedLiquidity = amountA && amountB
    ? totalSupply && reserveA && reserveB
      ? (amountA * totalSupply / reserveA < amountB * totalSupply / reserveB ? amountA * totalSupply / reserveA : amountB * totalSupply / reserveB)
      : (() => { const root = integerSquareRoot(amountA * amountB); return root > 1000n ? root - 1000n : 0n; })()
    : undefined;
  const projectedLpBalance = expectedLiquidity !== undefined
    ? (ownedLp ?? 0n) + expectedLiquidity
    : undefined;
  const projectedTotalSupply = expectedLiquidity !== undefined
    ? (totalSupply ?? 0n) + expectedLiquidity
    : undefined;
  const configured = Boolean(deployment.contracts.dexFactory && dexRouter && pool && addressA && addressB);
  const farmHref = fiPath(`/farm?pair=${routePairSlug}`);

  const error = useMemo(() => {
    if (mode === "add") {
      if ((!amountAText && !amountBText)) return undefined;
      if (!amountA || !amountB) return "Enter both token amounts.";
      if (availableA !== undefined && amountA > availableA) return `${tokenA} amount exceeds wallet balance.`;
      if (availableB !== undefined && amountB > availableB) return `${tokenB} amount exceeds wallet balance.`;
    } else if (lpText) {
      if (!liquidity) return "Enter a valid LP amount.";
      if (lpBalance !== undefined && liquidity > lpBalance) return "Amount exceeds your LP balance.";
    }
    return undefined;
  }, [amountA, amountAText, amountB, amountBText, availableA, availableB, liquidity, lpBalance, lpText, mode, tokenA, tokenB]);

  function updateAmountA(value: string) {
    setAmountAText(value);
    const parsed = parseAmount(value);
    if (parsed && reserveA && reserveB) setAmountBText(formatUnits(parsed * reserveB / reserveA, 18));
  }

  function updateAmountB(value: string) {
    setAmountBText(value);
    const parsed = parseAmount(value);
    if (parsed && reserveA && reserveB) setAmountAText(formatUnits(parsed * reserveA / reserveB, 18));
  }

  async function submitAdd() {
    if (!amountA || !amountB || !address || !addressA || !addressB) return;
    const nativePair = assets[tokenA].native || assets[tokenB].native;
    const approvals = [
      !assets[tokenA].native ? { token: addressA, spender: dexRouter, amount: amountA } : undefined,
      !assets[tokenB].native ? { token: addressB, spender: dexRouter, amount: amountB } : undefined,
    ].filter(Boolean) as Array<{ token: `0x${string}`; spender?: `0x${string}`; amount: bigint }>;
    const minimumLiquidity = expectedLiquidity ? minimumAfterSlippage(expectedLiquidity, slippageBps) : 0n;
    const nativeToken = assets[tokenA].native ? tokenB : tokenA;
    const nativeAmount = assets[tokenA].native ? amountA : amountB;
    const tokenAmount = assets[tokenA].native ? amountB : amountA;
    const tokenMinimum = minimumAfterSlippage(tokenAmount, slippageBps);
    const nativeMinimum = minimumAfterSlippage(nativeAmount, slippageBps);
    const call = nativePair
      ? {
          functionName: "addLiquidityNative",
          args: [{ token: assetForPool(nativeToken)!, amountTokenDesired: tokenAmount, amountTokenMin: tokenMinimum, amountNativeMin: nativeMinimum, minimumLiquidity, to: address, deadline: transactionDeadline() }] as const,
          value: nativeAmount,
        }
      : {
          functionName: "addLiquidity",
          args: [{ tokenA: addressA, tokenB: addressB, amountADesired: amountA, amountBDesired: amountB, amountAMin: minimumAfterSlippage(amountA, slippageBps), amountBMin: minimumAfterSlippage(amountB, slippageBps), minimumLiquidity, to: address, deadline: transactionDeadline() }] as const,
        };
    const hash = await tx.execute({
      approval: approvals,
      call: {
        address: dexRouter,
        abi: dexRouterAbi,
        functionName: call.functionName,
        args: call.args,
        value: "value" in call ? call.value : undefined,
      },
    });
    if (hash) {
      toast.show("Liquidity added", `Your share joined the shared ${pairLabel} pool.`, "success");
      setAmountAText(""); setAmountBText("");
      void poolStats.refetch(); void lpBalanceRead.refetch(); void stakedLpRead.refetch(); void reserveRead.refetch(); void balanceA.refetch(); void balanceB.refetch();
    }
  }

  async function submitRemove() {
    if (!liquidity || !address || !addressA || !addressB || !pool || removeAmountA === undefined || removeAmountB === undefined) return;
    const nativePair = assets[tokenA].native || assets[tokenB].native;
    const nativeAmount = assets[tokenA].native ? removeAmountA : removeAmountB;
    const tokenAmount = assets[tokenA].native ? removeAmountB : removeAmountA;
    const nativeToken = assets[tokenA].native ? tokenB : tokenA;
    const call = nativePair
      ? {
          functionName: "removeLiquidityNative",
          args: [{ token: assetForPool(nativeToken)!, liquidity, amountTokenMin: minimumAfterSlippage(tokenAmount, slippageBps), amountNativeMin: minimumAfterSlippage(nativeAmount, slippageBps), to: address, deadline: transactionDeadline() }] as const,
        }
      : {
          functionName: "removeLiquidity",
          args: [{ tokenA: addressA, tokenB: addressB, liquidity, amountAMin: minimumAfterSlippage(removeAmountA, slippageBps), amountBMin: minimumAfterSlippage(removeAmountB, slippageBps), to: address, deadline: transactionDeadline() }] as const,
        };
    const hash = await tx.execute({
      approval: { token: pool, spender: dexRouter, amount: liquidity },
      call: {
        address: dexRouter,
        abi: dexRouterAbi,
        functionName: call.functionName,
        args: call.args,
      },
    });
    if (hash) {
      toast.show("Liquidity removed", "LP tokens were burned and assets returned.", "success");
      setLpText(""); void poolStats.refetch(); void lpBalanceRead.refetch(); void stakedLpRead.refetch(); void reserveRead.refetch(); void balanceA.refetch(); void balanceB.refetch();
    }
  }

  return (
    <>
      {fromEarn ? (
        <section className="fi-earn-flow" aria-label="Liquidity farming setup">
          <div className="fi-earn-flow-step" data-state="active">
            <span>01</span>
            <div><strong>Add liquidity</strong><small>Current step</small></div>
          </div>
          <div className="fi-earn-flow-step" data-state={lpBalance && lpBalance > 0n ? "complete" : "pending"}>
            <span>02</span>
            <div><strong>Receive LP</strong><small>{lpBalance && lpBalance > 0n ? `${formatAmount(lpBalance)} available` : "Sent to your wallet"}</small></div>
          </div>
          <Link className="fi-earn-flow-step fi-earn-next" data-state={lpBalance && lpBalance > 0n ? "active" : "pending"} href={farmHref}>
            <span>03</span>
            <div><strong>Stake &amp; earn</strong><small>{lpBalance && lpBalance > 0n ? "Continue to Earn" : "After liquidity is added"}</small></div>
          </Link>
        </section>
      ) : null}
      <div className="fi-metric-strip">
        <div><dt>{tokenA} reserve</dt><dd>{formatAmount(reserveA)}</dd></div>
        <div><dt>{tokenB} reserve</dt><dd>{formatAmount(reserveB)}</dd></div>
        <div><dt>Total LP</dt><dd>{formatAmount(totalSupply)}</dd></div>
        <div><dt>Your share</dt><dd>{percentageShare(ownedLp, totalSupply)}</dd></div>
      </div>
      <div className="fi-workspace-grid fi-workspace-balance">
        <div className="fi-main-stack">
          <LazyMarketChart
            pair={routePairSlug}
            label={`${tokenB} price · ${tokenA}`}
            token0={{ symbol: tokenB }}
            token1={{ symbol: tokenA }}
          />
          <RecentActivity pair={routePairSlug} />
        </div>
        <section className="fi-panel fi-sticky-panel fi-trade-panel">
          <PanelHeading
            title={fromEarn ? "Get LP tokens" : "Liquidity"}
            trailing={fromEarn
              ? <Link className="fi-text-link" href={farmHref}>Back to Earn</Link>
              : <Link className="fi-text-link" href={`${fiPath("/swap")}?in=${tokenA}&out=${tokenB}`}>Swap pair</Link>}
          />
          {!configured ? <NotDeployed feature={`${pairLabel} liquidity`} /> : null}
          <div className="fi-segmented" role="group" aria-label="Liquidity action">
            <button type="button" className={mode === "add" ? "active positive" : ""} aria-pressed={mode === "add"} onClick={() => { setMode("add"); tx.reset(); }}>Add LP</button>
            <button type="button" className={mode === "remove" ? "active" : ""} aria-pressed={mode === "remove"} onClick={() => { setMode("remove"); tx.reset(); }}>Remove LP</button>
          </div>
          <div className="fi-form">
            {mode === "add" ? <>
              <AmountField id="pool-amount-a" label={tokenA} asset={tokenA} value={amountAText} balance={formatAmount(availableA)} onChange={updateAmountA} onMax={availableA && availableA > 0n ? () => updateAmountA(formatUnits(availableA, 18)) : undefined} error={error?.startsWith(tokenA) ? error : undefined} />
              <span className="fi-liquidity-plus" aria-hidden="true">+</span>
              <AmountField id="pool-amount-b" label={tokenB} asset={tokenB} value={amountBText} balance={formatAmount(availableB)} onChange={updateAmountB} onMax={availableB && availableB > 0n ? () => updateAmountB(formatUnits(availableB, 18)) : undefined} error={error?.startsWith(tokenB) || error?.startsWith("Enter") ? error : undefined} />
              {fromEarn ? (
                <nav className="fi-liquidity-shortcuts" aria-label="Get pool assets">
                  <span>Need assets?</span>
                  <Link className="fi-text-link" href={`${fiPath("/swap")}?in=zkLTC&out=NUSD`}>Get NUSD</Link>
                  {marketToken === "nBTC" || marketToken === "nETH" ? (
                    <Link className="fi-text-link" href={fiPath(`/synth?asset=${marketToken}`)}>Mint {marketToken}</Link>
                  ) : null}
                </nav>
              ) : null}
              <dl className="fi-form-details">
                <div><dt>You receive</dt><dd>{expectedLiquidity === undefined ? "--" : `~${formatAmount(expectedLiquidity)} LP`}</dd></div>
                <div><dt>Pool share</dt><dd>{percentageShare(projectedLpBalance, projectedTotalSupply)}</dd></div>
              </dl>
            </> : <>
              <AmountField id="pool-lp-amount" label="LP amount" asset="LP" value={lpText} balance={formatAmount(lpBalance)} onChange={setLpText} onMax={lpBalance && lpBalance > 0n ? () => setLpText(formatUnits(lpBalance, 18)) : undefined} error={error} />
              <dl className="fi-form-details">
                <div><dt>Expected {tokenA}</dt><dd>{formatAmount(removeAmountA)}</dd></div>
                <div><dt>Expected {tokenB}</dt><dd>{formatAmount(removeAmountB)}</dd></div>
              </dl>
            </>}
            <details className="fi-settings-details">
              <summary><span>Transaction settings</span><strong>{Number(slippageBps) / 100}% slippage</strong></summary>
              <SlippageControl value={slippageBps} onChange={setSlippageBps} />
            </details>
            {!isConnected ? <ConnectWalletButton /> : (
              <button type="button" className={`fi-button fi-button-block ${mode === "add" ? "fi-button-primary" : "fi-button-muted"}`} disabled={!configured || Boolean(error) || tx.pending || (mode === "add" ? !amountA || !amountB || !expectedLiquidity : !liquidity || removeAmountA === undefined || removeAmountB === undefined)} onClick={() => void (mode === "add" ? submitAdd() : submitRemove())}>
                {!configured ? "Not deployed" : tx.pending ? "Processing" : mode === "add" ? "Add liquidity & receive LP" : "Remove liquidity"}
              </button>
            )}
            <TransactionStatus phase={tx.phase} message={tx.message} hash={tx.hash} />
            {fromEarn && lpBalance !== undefined && lpBalance > 0n ? (
              <Link className="fi-button fi-button-muted fi-earn-next" href={farmHref}>
                Stake {formatAmount(lpBalance)} LP
              </Link>
            ) : null}
          </div>
        </section>
      </div>
    </>
  );
}
