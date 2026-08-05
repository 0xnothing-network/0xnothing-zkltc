"use client";

import { useMemo, useState } from "react";
import { ArrowsDownUp } from "@phosphor-icons/react";
import { zeroAddress } from "viem";
import { useAccount, useBalance, useReadContract } from "wagmi";
import { AmountField } from "@/components/AmountField";
import { AssetSelect, type AssetSelectOption } from "@/components/AssetSelect";
import { NotDeployed, PanelHeading, TransactionStatus } from "@/components/UiStates";
import { SlippageControl } from "@/components/SlippageControl";
import { deployment } from "@/config/deployment";
import { dexFactoryAbi, dexPoolAbi, dexRouterAbi } from "@/lib/abis/dex";
import { erc20Abi } from "@/lib/abis/erc20";
import { nusdOracleAbi } from "@/lib/abis/nusd";
import { formatAmount, minimumAfterSlippage, parseAmount, transactionDeadline } from "@/lib/format";
import { useActiveDexRouter } from "@/lib/hooks/useActiveDexRouter";
import { formatFeeBps, useDexFeeSchedule } from "@/lib/hooks/useDexFeeSchedule";
import { useProtocolTransaction } from "@/lib/hooks/useProtocolTransaction";
import { useSwapAssets } from "@/lib/hooks/useSwapAssets";
import { useToast } from "@/components/Toast";

const NATIVE_GAS_RESERVE_WEI = 10_000_000_000_000_000n;

export function SwapWorkspace() {
  const { address, isConnected } = useAccount();
  const toast = useToast();
  const swapAssets = useSwapAssets();
  const activeDexRouter = useActiveDexRouter();
  const feeSchedule = useDexFeeSchedule(activeDexRouter);
  const [tokenIn, setTokenIn] = useState("zkLTC");
  const [tokenOut, setTokenOut] = useState("NUSD");
  const [amountText, setAmountText] = useState("");
  const [slippageBps, setSlippageBps] = useState(50n);
  const tx = useProtocolTransaction();

  const assetMap = useMemo(() => new Map(swapAssets.data.map((asset) => [asset.id, asset])), [swapAssets.data]);
  const assetIn = assetMap.get(tokenIn) ?? swapAssets.data[0];
  const assetOut = assetMap.get(tokenOut) ?? swapAssets.data[1];
  const selectorEntries = useMemo<AssetSelectOption<string>[]>(() => swapAssets.data.map((asset) => ({
    value: asset.id,
    symbol: asset.symbol,
    name: asset.name,
    badge: asset.graduated ? "Graduated" : undefined,
  })), [swapAssets.data]);

  const nativeBalance = useBalance({
    address,
    query: { enabled: Boolean(address && assetIn?.native), refetchInterval: 12_000 },
  });
  const tokenBalance = useReadContract({
    address: assetIn?.native ? undefined : assetIn?.poolAddress,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    query: { enabled: Boolean(address && assetIn && !assetIn.native && assetIn.poolAddress), refetchInterval: 12_000 },
  });
  const balance = assetIn?.native ? nativeBalance.data?.value : tokenBalance.data;
  const spendableBalance = assetIn?.native && balance !== undefined
    ? balance > NATIVE_GAS_RESERVE_WEI ? balance - NATIVE_GAS_RESERVE_WEI : 0n
    : balance;
  const amountIn = assetIn ? parseAmount(amountText, assetIn.decimals) : undefined;
  const tokenInAddress = assetIn?.poolAddress;
  const tokenOutAddress = assetOut?.poolAddress;
  const canonicalNusd = deployment.contracts.nusd;
  const canonicalWzkLtc = deployment.contracts.wzkltc;
  const tokenInIsNusd = Boolean(
    tokenInAddress && canonicalNusd && tokenInAddress.toLowerCase() === canonicalNusd.toLowerCase(),
  );
  const tokenOutIsNusd = Boolean(
    tokenOutAddress && canonicalNusd && tokenOutAddress.toLowerCase() === canonicalNusd.toLowerCase(),
  );
  const tokenInIsWzkLtc = Boolean(
    assetIn?.native && tokenInAddress && canonicalWzkLtc
    && tokenInAddress.toLowerCase() === canonicalWzkLtc.toLowerCase(),
  );
  const tokenOutIsWzkLtc = Boolean(
    assetOut?.native && tokenOutAddress && canonicalWzkLtc
    && tokenOutAddress.toLowerCase() === canonicalWzkLtc.toLowerCase(),
  );
  const isOracleNusdRoute = Boolean(
    (tokenInIsWzkLtc && tokenOutIsNusd) || (tokenInIsNusd && tokenOutIsWzkLtc),
  );
  const isMintRoute = isOracleNusdRoute && tokenInIsWzkLtc;
  const shouldProbeDirectPair = Boolean(
    !isOracleNusdRoute
    && tokenInAddress
    && tokenOutAddress
    && !tokenInIsNusd
    && !tokenOutIsNusd,
  );
  const directPairState = useReadContract({
    address: deployment.contracts.dexFactory,
    abi: dexFactoryAbi,
    functionName: "getPair",
    args: shouldProbeDirectPair && tokenInAddress && tokenOutAddress
      ? [tokenInAddress, tokenOutAddress]
      : undefined,
    query: { enabled: Boolean(deployment.contracts.dexFactory && shouldProbeDirectPair) },
  });
  const directPair = directPairState.data && directPairState.data !== zeroAddress
    ? directPairState.data
    : undefined;
  const directReservesState = useReadContract({
    address: directPair,
    abi: dexPoolAbi,
    functionName: "getReserves",
    query: { enabled: Boolean(directPair) },
  });
  const directPairHasLiquidity = Boolean(
    directReservesState.data
    && directReservesState.data[0] > 0n
    && directReservesState.data[1] > 0n,
  );
  const path = useMemo(() => {
    if (!assetIn || !assetOut || !tokenInAddress || !tokenOutAddress || assetIn.id === assetOut.id) return undefined;
    if (tokenInIsNusd || tokenOutIsNusd) return [tokenInAddress, tokenOutAddress] as const;
    if (directPairHasLiquidity) return [tokenInAddress, tokenOutAddress] as const;
    return canonicalNusd ? [tokenInAddress, canonicalNusd, tokenOutAddress] as const : undefined;
  }, [assetIn, assetOut, canonicalNusd, directPairHasLiquidity, tokenInAddress, tokenInIsNusd, tokenOutAddress, tokenOutIsNusd]);
  const totalFeeBps = path
    && feeSchedule
    ? (path.length - 1) * feeSchedule.lpFeeBps
      + feeSchedule.protocolFeeBps
      + (path.length > 2 ? feeSchedule.routeSurchargeBps : 0)
    : undefined;
  const routeConfigured = isOracleNusdRoute
    ? Boolean(deployment.contracts.nusd)
    : Boolean(activeDexRouter && path);

  const dexQuote = useReadContract({
    address: activeDexRouter,
    abi: dexRouterAbi,
    functionName: "getAmountsOut",
    args: path && amountIn ? [amountIn, [...path]] : undefined,
    query: { enabled: Boolean(!isOracleNusdRoute && routeConfigured && amountIn), refetchInterval: 12_000 },
  });
  const mintQuote = useReadContract({
    address: deployment.contracts.nusd,
    abi: nusdOracleAbi,
    functionName: "quoteMint",
    args: isMintRoute && amountIn ? [amountIn] : undefined,
    query: { enabled: Boolean(isMintRoute && routeConfigured && amountIn), refetchInterval: 12_000 },
  });
  const redeemQuote = useReadContract({
    address: deployment.contracts.nusd,
    abi: nusdOracleAbi,
    functionName: "quoteRedeem",
    args: isOracleNusdRoute && !isMintRoute && amountIn ? [amountIn] : undefined,
    query: { enabled: Boolean(isOracleNusdRoute && !isMintRoute && routeConfigured && amountIn), refetchInterval: 12_000 },
  });
  const dexPauseState = useReadContract({
    address: deployment.contracts.dexFactory,
    abi: dexFactoryAbi,
    functionName: "swapsPaused",
    query: { enabled: Boolean(!isOracleNusdRoute && deployment.contracts.dexFactory), refetchInterval: 10_000 },
  });
  const mintPauseState = useReadContract({
    address: deployment.contracts.nusd,
    abi: nusdOracleAbi,
    functionName: "mintPaused",
    query: { enabled: Boolean(isMintRoute && deployment.contracts.nusd), refetchInterval: 10_000 },
  });
  const redeemPauseState = useReadContract({
    address: deployment.contracts.nusd,
    abi: nusdOracleAbi,
    functionName: "redeemPaused",
    query: { enabled: Boolean(isOracleNusdRoute && !isMintRoute && deployment.contracts.nusd), refetchInterval: 10_000 },
  });
  const supplyCeilingState = useReadContract({
    address: deployment.contracts.nusd,
    abi: nusdOracleAbi,
    functionName: "supplyCeilingNusd",
    query: { enabled: Boolean(isMintRoute && deployment.contracts.nusd), refetchInterval: 10_000 },
  });
  const totalSupplyState = useReadContract({
    address: deployment.contracts.nusd,
    abi: nusdOracleAbi,
    functionName: "totalSupply",
    query: { enabled: Boolean(isMintRoute && deployment.contracts.nusd), refetchInterval: 10_000 },
  });
  const collateralReserveState = useReadContract({
    address: deployment.contracts.nusd,
    abi: nusdOracleAbi,
    functionName: "totalCollateralWei",
    query: { enabled: Boolean(isOracleNusdRoute && !isMintRoute && deployment.contracts.nusd), refetchInterval: 10_000 },
  });

  const amountOut = amountIn
    ? isOracleNusdRoute
      ? isMintRoute ? mintQuote.data : redeemQuote.data
      : dexQuote.data?.at(-1)
    : undefined;
  const quoteFetching = isOracleNusdRoute
    ? isMintRoute ? mintQuote.isFetching : redeemQuote.isFetching
    : dexQuote.isFetching;
  const quoteError = isOracleNusdRoute
    ? isMintRoute ? mintQuote.error : redeemQuote.error
    : dexQuote.error;
  const routePaused = isOracleNusdRoute
    ? isMintRoute ? mintPauseState.data : redeemPauseState.data
    : dexPauseState.data;
  const pauseState = isOracleNusdRoute
    ? isMintRoute ? mintPauseState : redeemPauseState
    : dexPauseState;
  const capacityStateReady = !isOracleNusdRoute || (isMintRoute
    ? supplyCeilingState.data !== undefined && totalSupplyState.data !== undefined && !supplyCeilingState.error && !totalSupplyState.error
    : collateralReserveState.data !== undefined && !collateralReserveState.error);
  const routeStateReady = pauseState.data !== undefined && !pauseState.error && capacityStateReady;

  const validation = useMemo(() => {
    if (!amountText) return undefined;
    if (!amountIn || !assetIn) return "Enter a valid positive amount.";
    if (spendableBalance !== undefined && amountIn > spendableBalance) {
      return assetIn.native ? "Leave at least 0.01 zkLTC in your wallet for network fees." : "Amount exceeds wallet balance.";
    }
    if (quoteError) return isOracleNusdRoute ? "A fresh DIA oracle quote is unavailable." : "The router quote is unavailable.";
    if (isMintRoute && (supplyCeilingState.error || totalSupplyState.error)) return "NUSD mint capacity is unavailable.";
    if (isMintRoute && amountOut !== undefined && supplyCeilingState.data !== undefined && totalSupplyState.data !== undefined) {
      const remainingCapacity = supplyCeilingState.data > totalSupplyState.data ? supplyCeilingState.data - totalSupplyState.data : 0n;
      if (amountOut > remainingCapacity) return "Amount exceeds the remaining NUSD mint capacity.";
    }
    if (isOracleNusdRoute && !isMintRoute && collateralReserveState.error) return "NUSD reserve data is unavailable.";
    if (isOracleNusdRoute && !isMintRoute && amountOut !== undefined && collateralReserveState.data !== undefined && amountOut > collateralReserveState.data) {
      return "The NUSD native reserve cannot cover this redemption.";
    }
    return undefined;
  }, [amountIn, amountOut, amountText, assetIn, collateralReserveState.data, collateralReserveState.error, isMintRoute, isOracleNusdRoute, quoteError, spendableBalance, supplyCeilingState.data, supplyCeilingState.error, totalSupplyState.data, totalSupplyState.error]);

  function resetAmount() {
    setAmountText("");
    tx.reset();
  }

  function flip() {
    setTokenIn(tokenOut);
    setTokenOut(tokenIn);
    resetAmount();
  }

  function chooseIn(next: string) {
    setTokenIn(next);
    if (next === tokenOut) setTokenOut(next === "NUSD" ? "zkLTC" : "NUSD");
    resetAmount();
  }

  function chooseOut(next: string) {
    setTokenOut(next);
    if (next === tokenIn) setTokenIn(next === "NUSD" ? "zkLTC" : "NUSD");
    resetAmount();
  }

  async function submit() {
    if (!amountIn || !amountOut || !address || !assetIn || !assetOut) return;
    const minimumOut = minimumAfterSlippage(amountOut, slippageBps);
    if (isOracleNusdRoute) {
      const hash = isMintRoute
        ? await tx.execute({ call: { address: deployment.contracts.nusd, abi: nusdOracleAbi, functionName: "mintAtOracle", args: [minimumOut, address], value: amountIn } })
        : await tx.execute({ call: { address: deployment.contracts.nusd, abi: nusdOracleAbi, functionName: "redeemAtOracle", args: [amountIn, minimumOut, address] } });
      if (hash) {
        toast.show("Swap confirmed", `${amountText} ${assetIn.symbol} was settled at the DIA oracle value.`, "success");
        setAmountText("");
        void nativeBalance.refetch(); void tokenBalance.refetch(); void mintQuote.refetch(); void redeemQuote.refetch();
      }
      return;
    }

    if (!tokenInAddress || !tokenOutAddress || !path) return;
    const swapCall = assetIn.native
      ? { functionName: "swapExactNativeForTokens", args: [minimumOut, [...path], address, transactionDeadline()] as const, value: amountIn }
      : assetOut.native
        ? { functionName: "swapExactTokensForNative", args: [amountIn, minimumOut, [...path], address, transactionDeadline()] as const }
        : { functionName: "swapExactTokensForTokens", args: [amountIn, minimumOut, [...path], address, transactionDeadline()] as const };
    const hash = await tx.execute({
      approval: assetIn.native ? undefined : { token: tokenInAddress, spender: activeDexRouter, amount: amountIn },
      call: { address: activeDexRouter, abi: dexRouterAbi, functionName: swapCall.functionName, args: swapCall.args, value: "value" in swapCall ? swapCall.value : undefined },
    });
    if (hash) {
      toast.show("Swap confirmed", `${amountText} ${assetIn.symbol} was settled on LitVM.`, "success");
      setAmountText("");
      void nativeBalance.refetch(); void tokenBalance.refetch(); void dexQuote.refetch();
    }
  }

  return (
    <section className="fi-panel fi-sticky-panel">
      <PanelHeading title="SWAP" />
      {!routeConfigured ? <NotDeployed feature="The selected swap route" /> : null}
      {routePaused ? <div className="fi-inline-state fi-inline-danger" role="alert"><div><strong>{isOracleNusdRoute ? isMintRoute ? "NUSD mint paused" : "NUSD redeem paused" : "Swaps paused"}</strong><p>Temporarily unavailable.</p></div></div> : null}
      {isOracleNusdRoute ? <div className="fi-inline-state"><div><strong>DIA / $1 = 1 NUSD</strong><p>{isMintRoute ? "Mint / 0% fee" : "Redeem / 0% fee"}</p></div></div> : assetIn?.graduated || assetOut?.graduated ? <div className="fi-inline-state fi-inline-positive"><div><strong>Graduated DEX market</strong><p>Liquidity was seeded automatically after the 0xPump bonding curve completed.</p></div></div> : null}
      <div className="fi-form">
        <AssetSelect id="swap-in-token" label="Pay asset" value={tokenIn} entries={selectorEntries} onChange={chooseIn} />
        <AmountField id="swap-amount-in" label="You pay" asset={assetIn?.symbol ?? "--"} value={amountText} balance={formatAmount(balance, assetIn?.decimals ?? 18)} error={validation} onChange={setAmountText} onMax={spendableBalance !== undefined && spendableBalance > 0n ? () => setAmountText(formatAmount(spendableBalance, assetIn?.decimals ?? 18, 18).replace(/,/g, "")) : undefined} />
        <button type="button" className="fi-icon-button fi-swap-arrow" onClick={flip} aria-label="Reverse swap direction"><ArrowsDownUp size={18} weight="bold" aria-hidden="true" /></button>
        <AssetSelect id="swap-out-token" label="Receive asset" value={tokenOut} entries={selectorEntries} onChange={chooseOut} />
        <AmountField id="swap-amount-out" label="Expected output" asset={assetOut?.symbol ?? "--"} value={amountOut ? formatAmount(amountOut, assetOut?.decimals ?? 18, 18).replace(/,/g, "") : ""} helper={quoteFetching ? "Refreshing quote" : undefined} readOnly />
        <SlippageControl value={slippageBps} onChange={setSlippageBps} />
        <dl className="fi-form-details">
          <div><dt>Fee</dt><dd>{isOracleNusdRoute ? "0%" : formatFeeBps(totalFeeBps)}</dd></div>
          <div><dt>Route</dt><dd>{isOracleNusdRoute ? isMintRoute ? "NUSD oracle mint" : "NUSD oracle redeem" : path ? path.length === 2 ? "Direct pool" : "Via NUSD" : "--"}</dd></div>
          <div><dt>{isOracleNusdRoute ? "Pricing" : "Deadline"}</dt><dd>{isOracleNusdRoute ? "DIA LTC/USD" : "20 minutes"}</dd></div>
        </dl>
        <button type="button" className="fi-button fi-button-primary fi-button-block" disabled={!routeConfigured || !routeStateReady || routePaused || quoteFetching || !isConnected || !amountIn || !amountOut || Boolean(validation) || tx.pending} onClick={() => void submit()}>
          {!routeConfigured ? "Not deployed" : !routeStateReady ? "Checking route" : routePaused ? "Route paused" : !isConnected ? "Connect wallet" : tx.pending ? "Processing" : "Swap"}
        </button>
        <TransactionStatus phase={tx.phase} message={tx.message} hash={tx.hash} />
      </div>
    </section>
  );
}
