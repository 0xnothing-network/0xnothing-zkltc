"use client";

import { useEffect, useMemo, useState } from "react";
import { ArrowsDownUp, MagnifyingGlass } from "@phosphor-icons/react";
import { formatUnits, getAddress, isAddress } from "viem";
import { useAccount, useBalance, useReadContract } from "wagmi";
import type { AssetSelectOption } from "@fi/components/AssetSelect";
import { ConnectWalletButton } from "@fi/components/ConnectWalletButton";
import { SwapAmountField } from "@fi/components/SwapAmountField";
import { NotDeployed, PanelHeading, TransactionStatus } from "@fi/components/UiStates";
import { SlippageControl } from "@fi/components/SlippageControl";
import { deployment, explorerAddressUrl } from "@fi/config/deployment";
import { dexFactoryAbi, dexRouterAbi } from "@fi/lib/abis/dex";
import { erc20Abi } from "@fi/lib/abis/erc20";
import { nusdOracleAbi } from "@fi/lib/abis/nusd";
import { formatAmount, minimumAfterSlippage, parseAmount, shortAddress, transactionDeadline } from "@fi/lib/format";
import { useActiveDexRouter } from "@fi/lib/hooks/useActiveDexRouter";
import { formatFeeBps, useDexFeeSchedule } from "@fi/lib/hooks/useDexFeeSchedule";
import { useImportedSwapAsset } from "@fi/lib/hooks/useImportedSwapAsset";
import { useProtocolTransaction } from "@fi/lib/hooks/useProtocolTransaction";
import { useSwapAssets, type SwapAsset } from "@fi/lib/hooks/useSwapAssets";
import { useSwapRoute } from "@fi/lib/hooks/useSwapRoute";
import { useToast } from "@fi/components/Toast";

const NATIVE_GAS_RESERVE_WEI = 10_000_000_000_000_000n;
const RATE_PRECISION = 10n ** 18n;
const CANONICAL_SWAP_IDS = new Set(["zkLTC", "NUSD", "nBTC", "nETH"]);
type ImportSide = "pay" | "receive";

function mergeVerifiedMetadata(asset: SwapAsset, verified: SwapAsset): SwapAsset {
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

function quotedRate(
  amountIn: bigint | undefined,
  inputDecimals: number,
  amountOut: bigint | undefined,
  outputDecimals: number,
): string | undefined {
  if (!amountIn || !amountOut) return undefined;
  const inputScale = 10n ** BigInt(inputDecimals);
  const outputScale = 10n ** BigInt(outputDecimals);
  const rate = amountOut * inputScale * RATE_PRECISION / (amountIn * outputScale);
  return formatAmount(rate, 18, 4);
}

export function SwapWorkspace() {
  const { address, isConnected } = useAccount();
  const toast = useToast();
  const swapAssets = useSwapAssets();
  const activeDexRouter = useActiveDexRouter();
  const feeSchedule = useDexFeeSchedule(activeDexRouter);
  const [tokenIn, setTokenIn] = useState("NUSD");
  const [tokenOut, setTokenOut] = useState("zkLTC");
  const [amountText, setAmountText] = useState("");
  const [payContract, setPayContract] = useState("");
  const [receiveContract, setReceiveContract] = useState("");
  const [importSide, setImportSide] = useState<ImportSide>("receive");
  const [importedAssets, setImportedAssets] = useState<SwapAsset[]>([]);
  const [slippageBps, setSlippageBps] = useState(50n);
  const tx = useProtocolTransaction();
  const resetTransaction = tx.reset;

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const requestedIn = params.get("in");
    const requestedOut = params.get("out");
    const duplicateRequest = Boolean(
      requestedIn && requestedOut && requestedIn.toLowerCase() === requestedOut.toLowerCase(),
    );

    if (requestedIn) {
      if (CANONICAL_SWAP_IDS.has(requestedIn)) {
        setTokenIn(requestedIn);
        if (duplicateRequest && requestedIn === "NUSD") setTokenOut("zkLTC");
      } else if (isAddress(requestedIn)) {
        setPayContract(requestedIn);
        setImportSide("pay");
      }
    }
    if (requestedOut && !duplicateRequest) {
      if (CANONICAL_SWAP_IDS.has(requestedOut)) {
        setTokenOut(requestedOut);
      } else if (isAddress(requestedOut)) {
        setReceiveContract(requestedOut);
        setImportSide("receive");
      }
    }
  }, []);

  const payCandidate = useMemo(() => {
    const value = payContract.trim();
    return value && isAddress(value) ? getAddress(value) : undefined;
  }, [payContract]);
  const receiveCandidate = useMemo(() => {
    const value = receiveContract.trim();
    return value && isAddress(value) ? getAddress(value) : undefined;
  }, [receiveContract]);
  const sessionAssets = useMemo(() => [...swapAssets.data, ...importedAssets.filter((importedAsset) => (
    !swapAssets.data.some((asset) => asset.id === importedAsset.id)
  ))], [importedAssets, swapAssets.data]);
  // Every explicitly pasted address goes through the Explorer-backed API,
  // including tokens already present in the pool index.
  const importedPay = useImportedSwapAsset(payContract);
  const importedReceive = useImportedSwapAsset(receiveContract);
  const availableAssets = useMemo<SwapAsset[]>(() => {
    const verifiedAssets = [importedPay.asset, importedReceive.asset].filter(
      (asset): asset is SwapAsset => Boolean(asset?.poolAddress),
    );
    const next = sessionAssets.map((asset) => {
      const verified = verifiedAssets.find((candidate) => (
        candidate.poolAddress?.toLowerCase() === asset.poolAddress?.toLowerCase()
      ));
      return verified ? mergeVerifiedMetadata(asset, verified) : asset;
    });
    for (const asset of verifiedAssets) {
      if (asset && !next.some((candidate) => candidate.id === asset.id)) next.push(asset);
    }
    return next;
  }, [importedPay.asset, importedReceive.asset, sessionAssets]);
  const assetMap = useMemo(() => new Map(availableAssets.map((asset) => [asset.id, asset])), [availableAssets]);
  const resolvedPayAsset = importedPay.status === "ready" && payCandidate
    ? availableAssets.find((asset) => asset.poolAddress?.toLowerCase() === payCandidate.toLowerCase())
      ?? importedPay.asset
    : undefined;
  const resolvedReceiveAsset = importedReceive.status === "ready" && receiveCandidate
    ? availableAssets.find((asset) => asset.poolAddress?.toLowerCase() === receiveCandidate.toLowerCase())
      ?? importedReceive.asset
    : undefined;
  const assetIn = assetMap.get(tokenIn);
  const assetOut = assetMap.get(tokenOut);
  const selectorEntries = useMemo<AssetSelectOption<string>[]>(() => availableAssets.map((asset) => ({
    value: asset.id,
    symbol: asset.symbol,
    name: asset.name,
    badge: asset.imported ? "Imported" : asset.graduated ? "Graduated" : undefined,
    detail: !asset.trustedCore && asset.poolAddress ? shortAddress(asset.poolAddress) : undefined,
    imageUrl: asset.imageUrl,
    trustedCore: asset.trustedCore,
  })), [availableAssets]);
  const paySelectorEntries = useMemo(() => [...selectorEntries].sort((left, right) => {
    if (left.value === "NUSD") return -1;
    if (right.value === "NUSD") return 1;
    return 0;
  }), [selectorEntries]);

  useEffect(() => {
    if (assetIn && assetOut && assetIn.id !== assetOut.id) return;

    const nextAssetIn = assetIn
      ?? assetMap.get("NUSD")
      ?? availableAssets[0];
    const nextAssetOut = assetOut && assetOut.id !== nextAssetIn?.id
      ? assetOut
      : assetMap.get("zkLTC")?.id !== nextAssetIn?.id
        ? assetMap.get("zkLTC")
        : assetMap.get("NUSD")?.id !== nextAssetIn?.id
          ? assetMap.get("NUSD")
          : availableAssets.find((asset) => asset.id !== nextAssetIn?.id);

    if (!nextAssetIn || !nextAssetOut) return;
    if (nextAssetIn.id !== tokenIn) {
      setTokenIn(nextAssetIn.id);
      setPayContract("");
    }
    if (nextAssetOut.id !== tokenOut) {
      setTokenOut(nextAssetOut.id);
      setReceiveContract("");
    }
    setAmountText("");
    resetTransaction();
  }, [assetIn, assetMap, assetOut, availableAssets, resetTransaction, tokenIn, tokenOut]);

  useEffect(() => {
    const detectedPay = resolvedPayAsset;
    const detectedReceive = resolvedReceiveAsset;
    const detectedImported = [detectedPay, detectedReceive].filter(
      (asset): asset is SwapAsset => Boolean(asset?.imported),
    );
    if (detectedImported.length > 0) {
      setImportedAssets((current) => {
        const next = [...current];
        for (const asset of detectedImported) {
          if (!next.some((candidate) => candidate.id === asset.id)) next.push(asset);
        }
        return next.length > current.length ? next : current;
      });
    }
    if (!detectedPay && !detectedReceive) return;

    let nextTokenIn = detectedPay?.id ?? tokenIn;
    let nextTokenOut = detectedReceive?.id ?? tokenOut;
    let clearPayContract = false;
    let clearReceiveContract = false;

    if (nextTokenIn === nextTokenOut) {
      if (detectedPay) {
        nextTokenOut = nextTokenIn === "NUSD" ? "zkLTC" : "NUSD";
        clearReceiveContract = true;
      } else {
        nextTokenIn = nextTokenOut === "NUSD" ? "zkLTC" : "NUSD";
        clearPayContract = true;
      }
    }

    const selectionChanged = nextTokenIn !== tokenIn || nextTokenOut !== tokenOut;
    if (nextTokenIn !== tokenIn) setTokenIn(nextTokenIn);
    if (nextTokenOut !== tokenOut) setTokenOut(nextTokenOut);
    if (clearPayContract && payContract) setPayContract("");
    if (clearReceiveContract && receiveContract) setReceiveContract("");
    if (selectionChanged || clearPayContract || clearReceiveContract) {
      setAmountText("");
      resetTransaction();
    }
  }, [
    payContract,
    receiveContract,
    resolvedPayAsset,
    resolvedReceiveAsset,
    resetTransaction,
    tokenIn,
    tokenOut,
  ]);

  const nativeBalance = useBalance({
    address,
    query: { enabled: Boolean(address && assetIn?.native) },
  });
  const tokenBalance = useReadContract({
    address: assetIn?.native ? undefined : assetIn?.poolAddress,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    query: { enabled: Boolean(address && assetIn && !assetIn.native && assetIn.poolAddress) },
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
  const swapRoute = useSwapRoute({
    amountIn,
    factory: deployment.contracts.dexFactory,
    input: tokenInAddress,
    isOracleRoute: isOracleNusdRoute,
    nusd: canonicalNusd,
    output: tokenOutAddress,
    router: activeDexRouter,
  });
  const path = swapRoute.path;
  const totalFeeBps = path
    && feeSchedule
    ? (path.length - 1) * feeSchedule.lpFeeBps
      + feeSchedule.protocolFeeBps
      + (path.length > 2 ? feeSchedule.routeSurchargeBps : 0)
    : undefined;
  const routeConfigured = isOracleNusdRoute
    ? Boolean(deployment.contracts.nusd)
    : swapRoute.kind === "direct" || swapRoute.kind === "via-nusd";
  const mintQuote = useReadContract({
    address: deployment.contracts.nusd,
    abi: nusdOracleAbi,
    functionName: "quoteMint",
    args: isMintRoute && amountIn ? [amountIn] : undefined,
    query: { enabled: Boolean(isMintRoute && routeConfigured && amountIn) },
  });
  const redeemQuote = useReadContract({
    address: deployment.contracts.nusd,
    abi: nusdOracleAbi,
    functionName: "quoteRedeem",
    args: isOracleNusdRoute && !isMintRoute && amountIn ? [amountIn] : undefined,
    query: { enabled: Boolean(isOracleNusdRoute && !isMintRoute && routeConfigured && amountIn) },
  });
  const dexPauseState = useReadContract({
    address: deployment.contracts.dexFactory,
    abi: dexFactoryAbi,
    functionName: "swapsPaused",
    query: { enabled: Boolean(!isOracleNusdRoute && deployment.contracts.dexFactory) },
  });
  const mintPauseState = useReadContract({
    address: deployment.contracts.nusd,
    abi: nusdOracleAbi,
    functionName: "mintPaused",
    query: { enabled: Boolean(isMintRoute && deployment.contracts.nusd) },
  });
  const redeemPauseState = useReadContract({
    address: deployment.contracts.nusd,
    abi: nusdOracleAbi,
    functionName: "redeemPaused",
    query: { enabled: Boolean(isOracleNusdRoute && !isMintRoute && deployment.contracts.nusd) },
  });
  const supplyCeilingState = useReadContract({
    address: deployment.contracts.nusd,
    abi: nusdOracleAbi,
    functionName: "supplyCeilingNusd",
    query: { enabled: Boolean(isMintRoute && deployment.contracts.nusd) },
  });
  const totalSupplyState = useReadContract({
    address: deployment.contracts.nusd,
    abi: nusdOracleAbi,
    functionName: "totalSupply",
    query: { enabled: Boolean(isMintRoute && deployment.contracts.nusd) },
  });
  const collateralReserveState = useReadContract({
    address: deployment.contracts.nusd,
    abi: nusdOracleAbi,
    functionName: "totalCollateralWei",
    query: { enabled: Boolean(isOracleNusdRoute && !isMintRoute && deployment.contracts.nusd) },
  });

  const amountOut = amountIn
    ? isOracleNusdRoute
      ? isMintRoute ? mintQuote.data : redeemQuote.data
      : swapRoute.amountOut
    : undefined;
  const minimumReceived = amountOut ? minimumAfterSlippage(amountOut, slippageBps) : undefined;
  const oracleQuotePending = Boolean(amountIn && (
    isMintRoute
      ? mintQuote.data === undefined && !mintQuote.error
      : redeemQuote.data === undefined && !redeemQuote.error
  ));
  const quoteFetching = isOracleNusdRoute ? oracleQuotePending : swapRoute.isFetching;
  const quoteError = isOracleNusdRoute
    ? isMintRoute ? mintQuote.error : redeemQuote.error
    : swapRoute.error;
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
  const rate = quotedRate(
    amountIn,
    assetIn?.decimals ?? 18,
    amountOut,
    assetOut?.decimals ?? 18,
  );
  const feeLabel = isOracleNusdRoute ? "0%" : formatFeeBps(totalFeeBps);
  const routeLabel = (() => {
    const from = assetIn?.symbol;
    const to = assetOut?.symbol;
    if (!from || !to) return undefined;
    if (isOracleNusdRoute) return `${from} → ${to}`;
    if (swapRoute.kind === "via-nusd") return `${from} → NUSD → ${to}`;
    if (swapRoute.kind === "direct") return `${from} → ${to}`;
    return undefined;
  })();
  const infrastructureConfigured = isOracleNusdRoute
    ? Boolean(deployment.contracts.nusd)
    : Boolean(deployment.contracts.dexFactory && activeDexRouter);
  const detectedPayAsset = resolvedPayAsset;
  const detectedReceiveAsset = resolvedReceiveAsset;
  const payContractReady = !payContract.trim() || Boolean(
    importedPay.status === "ready" && detectedPayAsset && assetIn?.id === detectedPayAsset.id,
  );
  const receiveContractReady = !receiveContract.trim() || Boolean(
    importedReceive.status === "ready" && detectedReceiveAsset && assetOut?.id === detectedReceiveAsset.id,
  );
  const importedContractsReady = payContractReady && receiveContractReady;

  function importStatus(
    value: string,
    detected: SwapAsset | undefined,
    imported: ReturnType<typeof useImportedSwapAsset>,
  ) {
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

  const payContractStatus = importStatus(payContract, detectedPayAsset, importedPay);
  const receiveContractStatus = importStatus(receiveContract, detectedReceiveAsset, importedReceive);
  const activeContract = importSide === "pay" ? payContract : receiveContract;
  const activeDetectedAsset = importSide === "pay" ? detectedPayAsset : detectedReceiveAsset;
  const activeContractStatus = importSide === "pay" ? payContractStatus : receiveContractStatus;

  function updateActiveContract(value: string) {
    if (importSide === "pay") setPayContract(value);
    else setReceiveContract(value);
    resetAmount();
  }
  const routeLiquidityStatus = (() => {
    if (!payContract.trim() && !receiveContract.trim()) return undefined;
    if (!importedContractsReady || !detectedPayAsset && !detectedReceiveAsset) return undefined;
    if (isOracleNusdRoute) return "Liquidity found · 0% fee";
    if (swapRoute.kind === "checking") return "Checking direct and NUSD liquidity…";
    if (swapRoute.kind === "direct") return "Direct liquidity found";
    if (swapRoute.kind === "via-nusd") return "Liquidity found via NUSD";
    if (swapRoute.error) return "Liquidity check is temporarily unavailable.";
    return "No liquidity is available for this pair.";
  })();

  const validation = useMemo(() => {
    if (!amountText) return undefined;
    if (!amountIn || !assetIn) return "Enter a valid positive amount.";
    if (!importedContractsReady) return "Resolve both token contracts before swapping.";
    if (quoteError) return "A fresh swap quote is unavailable.";
    if (!routeConfigured) return "No liquidity is available for this pair.";
    if (spendableBalance !== undefined && amountIn > spendableBalance) {
      return assetIn.native ? "Leave at least 0.01 zkLTC in your wallet for network fees." : "Amount exceeds wallet balance.";
    }
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
  }, [amountIn, amountOut, amountText, assetIn, collateralReserveState.data, collateralReserveState.error, importedContractsReady, isMintRoute, isOracleNusdRoute, quoteError, routeConfigured, spendableBalance, supplyCeilingState.data, supplyCeilingState.error, totalSupplyState.data, totalSupplyState.error]);

  function resetAmount() {
    setAmountText("");
    resetTransaction();
  }

  function flip() {
    setTokenIn(tokenOut);
    setTokenOut(tokenIn);
    setPayContract(receiveContract);
    setReceiveContract(payContract);
    setImportSide((current) => current === "pay" ? "receive" : "pay");
    resetAmount();
  }

  function chooseIn(next: string) {
    setTokenIn(next);
    setPayContract("");
    if (next === tokenOut) {
      setTokenOut(next === "NUSD" ? "zkLTC" : "NUSD");
      setReceiveContract("");
    }
    resetAmount();
  }

  function chooseOut(next: string) {
    setTokenOut(next);
    setReceiveContract("");
    if (next === tokenIn) {
      setTokenIn(next === "NUSD" ? "zkLTC" : "NUSD");
      setPayContract("");
    }
    resetAmount();
  }

  async function submit() {
    if (
      !importedContractsReady || !routeConfigured || !routeStateReady || routePaused || quoteFetching
      || validation || tx.pending || !amountIn || !amountOut || !address || !assetIn || !assetOut
    ) return;
    const minimumOut = minimumAfterSlippage(amountOut, slippageBps);
    if (isOracleNusdRoute) {
      const hash = isMintRoute
        ? await tx.execute({ call: { address: deployment.contracts.nusd, abi: nusdOracleAbi, functionName: "mintAtOracle", args: [minimumOut, address], value: amountIn } })
        : await tx.execute({ call: { address: deployment.contracts.nusd, abi: nusdOracleAbi, functionName: "redeemAtOracle", args: [amountIn, minimumOut, address] } });
      if (hash) {
        toast.show("Swap confirmed", `${amountText} ${assetIn.symbol} was swapped for ${assetOut.symbol}.`, "success");
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
      void nativeBalance.refetch(); void tokenBalance.refetch();
    }
  }

  return (
    <section className="fi-panel fi-sticky-panel fi-swap-terminal" aria-labelledby="fi-swap-title">
      <h1 id="fi-swap-title" className="sr-only">Swap</h1>
      <PanelHeading
        title="Swap"
        trailing={<span className="fi-status" data-state="healthy">{feeLabel === "--" ? "Fee --" : `${feeLabel} fee`}</span>}
      />
      {!infrastructureConfigured ? <NotDeployed feature="The selected swap infrastructure" /> : null}
      {routePaused ? <div className="fi-inline-state fi-inline-danger" role="alert"><div><strong>Swaps paused</strong><p>Temporarily unavailable.</p></div></div> : null}
      <form className="fi-form" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
        <SwapAmountField
          id="swap-amount-in"
          assetSelectId="swap-in-token"
          label="You pay"
          assetLabel="Pay asset"
          asset={assetIn?.symbol ?? "--"}
          assetValue={tokenIn}
          assets={paySelectorEntries}
          value={amountText}
          balance={formatAmount(balance, assetIn?.decimals ?? 18)}
          error={validation}
          onAmountChange={setAmountText}
          onAssetChange={chooseIn}
          onMax={spendableBalance !== undefined && spendableBalance > 0n ? () => setAmountText(formatUnits(spendableBalance, assetIn?.decimals ?? 18)) : undefined}
        />
        <button type="button" className="fi-icon-button fi-swap-arrow" onClick={flip} aria-label="Reverse swap direction"><ArrowsDownUp size={18} weight="regular" aria-hidden="true" /></button>
        <SwapAmountField
          id="swap-amount-out"
          assetSelectId="swap-out-token"
          label="You receive"
          assetLabel="Receive asset"
          asset={assetOut?.symbol ?? "--"}
          assetValue={tokenOut}
          assets={selectorEntries}
          value={amountOut ? formatAmount(amountOut, assetOut?.decimals ?? 18, 8).replace(/,/g, "") : ""}
          helper={quoteFetching
            ? "Checking liquidity…"
            : !isOracleNusdRoute && swapRoute.error
              ? swapRoute.kind === "unavailable"
                ? "Liquidity check is temporarily unavailable."
                : "A fresh quote is temporarily unavailable."
            : !isOracleNusdRoute && swapRoute.kind === "unavailable"
              ? "No liquidity is available for this pair."
              : undefined}
          onAssetChange={chooseOut}
          readOnly
        />
        <details className="fi-settings-details fi-token-import-details">
          <summary>
            <span>Import token address</span>
            <strong>{activeDetectedAsset ? `${importSide === "pay" ? "Pay" : "Receive"} ${activeDetectedAsset.symbol}` : `${importSide === "pay" ? "Pay" : "Receive"} CA`}</strong>
          </summary>
          <div className="fi-token-address-import" data-state={activeContractStatus.tone}>
            <div className="fi-segmented fi-import-side-switch" role="group" aria-label="Token address side">
              <button type="button" className={importSide === "pay" ? "active" : ""} aria-pressed={importSide === "pay"} onClick={() => setImportSide("pay")}>Pay</button>
              <button type="button" className={importSide === "receive" ? "active" : ""} aria-pressed={importSide === "receive"} onClick={() => setImportSide("receive")}>Receive</button>
            </div>
            <div className="fi-field-label-row">
              <label htmlFor="swap-token-contract">{importSide === "pay" ? "Pay" : "Receive"} token address</label>
              {activeDetectedAsset?.poolAddress ? (
                <a href={explorerAddressUrl(activeDetectedAsset.poolAddress)} target="_blank" rel="noopener noreferrer">
                  Explorer
                </a>
              ) : <span>Paste CA</span>}
            </div>
            <div className="fi-contract-input">
              <MagnifyingGlass size={15} aria-hidden="true" />
              <input
                id="swap-token-contract"
                type="text"
                inputMode="text"
                autoCapitalize="none"
                autoComplete="off"
                spellCheck={false}
                value={activeContract}
                placeholder={`Paste ${importSide} token address / 0x…`}
                aria-describedby="swap-token-contract-status"
                onChange={(event) => updateActiveContract(event.target.value)}
              />
              <span>CA</span>
            </div>
            <output id="swap-token-contract-status" className="fi-contract-status" aria-live="polite">
              {activeContractStatus.message}
              {!activeDetectedAsset?.trustedCore && activeDetectedAsset?.poolAddress
                ? ` · ${shortAddress(activeDetectedAsset.poolAddress)}`
                : ""}
            </output>
          </div>
        </details>
        {routeLiquidityStatus ? (
          <div className="fi-inline-state" role="status" aria-live="polite">
            <div><strong>Swap route</strong><p>{routeLiquidityStatus}</p></div>
          </div>
        ) : null}
        {amountIn ? (
          <dl className="fi-form-details">
            {routeLabel ? (
              <div>
                <dt>Route</dt>
                <dd>
                  {routeLabel}
                  {swapRoute.kind === "via-nusd" ? <span className="fi-status" data-state="healthy">via NUSD</span> : null}
                </dd>
              </div>
            ) : null}
            <div><dt>Rate</dt><dd>{rate ? `${rate} ${assetOut?.symbol ?? ""} / ${assetIn?.symbol ?? ""}` : "--"}</dd></div>
            <div><dt>Minimum received</dt><dd>{minimumReceived ? `${formatAmount(minimumReceived, assetOut?.decimals ?? 18)} ${assetOut?.symbol ?? ""}` : "--"}</dd></div>
          </dl>
        ) : null}
        <details className="fi-settings-details">
          <summary><span>Settings</span><strong>{Number(slippageBps) / 100}% slippage</strong></summary>
          <SlippageControl value={slippageBps} onChange={setSlippageBps} />
        </details>
        {!isConnected ? (
          <ConnectWalletButton />
        ) : (
          <button type="submit" className="fi-button fi-button-primary fi-button-block" disabled={!importedContractsReady || !routeConfigured || !routeStateReady || routePaused || quoteFetching || !amountIn || !amountOut || Boolean(validation) || tx.pending}>
            {!importedContractsReady
              ? importedPay.status === "unavailable" || importedReceive.status === "unavailable" ? "Token check unavailable"
                : importedPay.status === "invalid" || importedPay.status === "unsupported"
                  || importedReceive.status === "invalid" || importedReceive.status === "unsupported" ? "Check token addresses"
                  : "Checking tokens"
              : !infrastructureConfigured ? "Not deployed"
                : swapRoute.kind === "checking" ? "Checking liquidity"
                  : swapRoute.error ? swapRoute.kind === "unavailable" ? "Liquidity check unavailable" : "Quote unavailable"
                    : !routeConfigured ? "No liquidity"
                      : !routeStateReady ? "Checking route"
                        : routePaused ? "Swaps paused"
                          : tx.pending ? "Processing"
                            : quoteFetching ? "Refreshing quote"
                              : "Swap"}
          </button>
        )}
        <TransactionStatus phase={tx.phase} message={tx.message} hash={tx.hash} />
      </form>
    </section>
  );
}
