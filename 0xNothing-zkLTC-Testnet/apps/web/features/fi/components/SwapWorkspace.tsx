"use client";

import { useEffect, useMemo, useState } from "react";
import { ArrowsDownUp, MagnifyingGlass } from "@phosphor-icons/react";
import { formatUnits, getAddress, isAddress } from "viem";
import { useAccount, useBalance, useReadContract, useReadContracts } from "wagmi";
import type { AssetSelectOption } from "@fi/components/AssetSelect";
import { ConnectWalletButton } from "@fi/components/ConnectWalletButton";
import { SwapAmountField } from "@fi/components/SwapAmountField";
import { NotDeployed, PanelHeading, TransactionStatus } from "@fi/components/UiStates";
import { SlippageControl } from "@fi/components/SlippageControl";
import { deployment, explorerAddressUrl } from "@fi/config/deployment";
import { dexRouterAbi } from "@fi/lib/abis/dex";
import { erc20Abi } from "@fi/lib/abis/erc20";
import { nusdOracleAbi } from "@fi/lib/abis/nusd";
import {
  formatAmount,
  formatTokenAmount,
  minimumAfterSlippage,
  parseAmount,
  shortAddress,
  transactionDeadline,
} from "@fi/lib/format";
import {
  buildDexSwapCall,
  computeExecutionImpactBps,
  importedTokenStatus,
  mergeVerifiedMetadata,
  quotedRate,
  readSwapDeepLink,
  spendableSwapBalance,
  swapButtonLabel,
  swapLiquidityStatus,
  swapRouteLabel,
  ORACLE_QUOTE_REFRESH_MS,
  type ImportSide,
} from "@fi/lib/swap";
import { useActiveDexRouter } from "@fi/lib/hooks/useActiveDexRouter";
import { formatFeeBps, useDexFeeSchedule } from "@fi/lib/hooks/useDexFeeSchedule";

import { useImportedSwapAsset } from "@fi/lib/hooks/useImportedSwapAsset";
import { useProtocolTransaction } from "@fi/lib/hooks/useProtocolTransaction";
import { useSwapAssets, type SwapAsset } from "@fi/lib/hooks/useSwapAssets";
import { useSwapRoute } from "@fi/lib/hooks/useSwapRoute";
import { useSwapRouteGuards } from "@fi/lib/hooks/useSwapRouteGuards";
import { useToast } from "@fi/components/Toast";

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
    const link = readSwapDeepLink(window.location.search);
    if (link.tokenIn) setTokenIn(link.tokenIn);
    if (link.tokenOut) setTokenOut(link.tokenOut);
    if (link.payContract) setPayContract(link.payContract);
    if (link.receiveContract) setReceiveContract(link.receiveContract);
    if (link.importSide) setImportSide(link.importSide);
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
  const spendableBalance = spendableSwapBalance(balance, Boolean(assetIn?.native));
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
    bridge: canonicalNusd,
    factory: deployment.contracts.dexFactory,
    input: tokenInAddress,
    isOracleRoute: isOracleNusdRoute,
    output: tokenOutAddress,
    router: activeDexRouter,
  });
  const path = swapRoute.path;

  const routeReserves = useReadContracts({
    contracts: !isOracleNusdRoute && activeDexRouter && path
      ? path.slice(0, -1).map((token, index) => ({
          address: activeDexRouter,
          abi: dexRouterAbi,
          functionName: "getReserves" as const,
          args: [token, path[index + 1]] as const,
        }))
      : [],
    query: { enabled: Boolean(!isOracleNusdRoute && activeDexRouter && path) },
  });
  const totalFeeBps = path && feeSchedule
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
    query: {
      enabled: Boolean(isMintRoute && routeConfigured && amountIn),
      refetchInterval: ORACLE_QUOTE_REFRESH_MS,
      refetchIntervalInBackground: false,
    },
  });
  const redeemQuote = useReadContract({
    address: deployment.contracts.nusd,
    abi: nusdOracleAbi,
    functionName: "quoteRedeem",
    args: isOracleNusdRoute && !isMintRoute && amountIn ? [amountIn] : undefined,
    query: {
      enabled: Boolean(isOracleNusdRoute && !isMintRoute && routeConfigured && amountIn),
      refetchInterval: ORACLE_QUOTE_REFRESH_MS,
      refetchIntervalInBackground: false,
    },
  });
  const {
    mintCapacityUnavailable,
    redeemReserve,
    redeemReserveUnavailable,
    remainingMintCapacity,
    routePaused,
    routeStateReady,
  } = useSwapRouteGuards({ isMintRoute, isOracleRoute: isOracleNusdRoute });

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
  const activeOracleQuote = isMintRoute ? mintQuote : redeemQuote;
  const oracleQuoteExecutable = Boolean(
    !isOracleNusdRoute
    || amountIn && amountOut !== undefined && !activeOracleQuote.isFetching && !activeOracleQuote.error,
  );
  const executableQuoteCurrent = isOracleNusdRoute
    ? oracleQuoteExecutable
    : swapRoute.amountInQuoted === amountIn;
  const quoteError = isOracleNusdRoute
    ? isMintRoute ? mintQuote.error : redeemQuote.error
    : swapRoute.error;
  const rate = quotedRate(
    amountIn,
    assetIn?.decimals ?? 18,
    amountOut,
    assetOut?.decimals ?? 18,
  );
  const executionImpactBps = useMemo(() => isOracleNusdRoute ? undefined : computeExecutionImpactBps({
    amountIn,
    amountOut,
    hops: path ? path.length - 1 : undefined,
    reserveReads: routeReserves.data,
  }), [amountIn, amountOut, isOracleNusdRoute, path, routeReserves.data]);
  const executionImpactLabel = executionImpactBps === undefined
    ? "--"
    : `${Number(executionImpactBps) / 100}%`;
  const executionImpactTone = executionImpactBps === undefined
    ? undefined
    : executionImpactBps >= 500n ? "danger" : executionImpactBps >= 100n ? "warning" : "positive";
  const feeLabel = isOracleNusdRoute ? "0%" : formatFeeBps(totalFeeBps);
  const routeLabel = swapRouteLabel({
    from: assetIn?.symbol,
    isOracleRoute: isOracleNusdRoute,
    kind: swapRoute.kind,
    to: assetOut?.symbol,
  });
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

  const payContractStatus = importedTokenStatus(payContract, detectedPayAsset, importedPay);
  const receiveContractStatus = importedTokenStatus(receiveContract, detectedReceiveAsset, importedReceive);
  const activeContract = importSide === "pay" ? payContract : receiveContract;
  const activeDetectedAsset = importSide === "pay" ? detectedPayAsset : detectedReceiveAsset;
  const activeContractStatus = importSide === "pay" ? payContractStatus : receiveContractStatus;

  function updateActiveContract(value: string) {
    if (importSide === "pay") setPayContract(value);
    else setReceiveContract(value);
    resetAmount();
  }
  const routeLiquidityStatus = swapLiquidityStatus({
    bridgeLive: swapRoute.bridgeLive,
    detected: Boolean(detectedPayAsset || detectedReceiveAsset),
    directLive: swapRoute.directLive,
    hasImportInput: Boolean(payContract.trim() || receiveContract.trim()),
    importsReady: importedContractsReady,
    isOracleRoute: isOracleNusdRoute,
    kind: swapRoute.kind,
    routeError: Boolean(swapRoute.error),
  });

  const validation = useMemo(() => {
    if (!amountText) return undefined;
    if (!amountIn || !assetIn) return "Enter a valid positive amount.";
    if (!importedContractsReady) return "Resolve both token contracts before swapping.";
    if (!executableQuoteCurrent) return "Waiting for a quote for the current amount.";
    if (quoteError) return "A fresh swap quote is unavailable.";
    if (!routeConfigured) return "No liquidity is available for this pair.";
    if (spendableBalance !== undefined && amountIn > spendableBalance) {
      return assetIn.native ? "Leave at least 0.01 zkLTC in your wallet for network fees." : "Amount exceeds wallet balance.";
    }
    if (isMintRoute && mintCapacityUnavailable) return "NUSD mint capacity is unavailable.";
    if (isMintRoute && amountOut !== undefined && remainingMintCapacity !== undefined) {
      if (amountOut > remainingMintCapacity) return "Amount exceeds the remaining NUSD mint capacity.";
    }
    if (isOracleNusdRoute && !isMintRoute && redeemReserveUnavailable) return "NUSD reserve data is unavailable.";
    if (isOracleNusdRoute && !isMintRoute && amountOut !== undefined && redeemReserve !== undefined && amountOut > redeemReserve) {
      return "The NUSD native reserve cannot cover this redemption.";
    }
    return undefined;
  }, [amountIn, amountOut, amountText, assetIn, executableQuoteCurrent, importedContractsReady, isMintRoute, isOracleNusdRoute, mintCapacityUnavailable, quoteError, redeemReserve, redeemReserveUnavailable, remainingMintCapacity, routeConfigured, spendableBalance]);

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
      !importedContractsReady || !routeConfigured || !routeStateReady || routePaused || quoteFetching || !executableQuoteCurrent
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
    const swapCall = buildDexSwapCall({
      amountIn,
      deadline: transactionDeadline(),
      minimumOut,
      path,
      payNative: assetIn.native,
      receiveNative: assetOut.native,
      recipient: address,
    });
    const hash = await tx.execute({
      approval: assetIn.native ? undefined : { token: tokenInAddress, spender: activeDexRouter, amount: amountIn },
      call: {
        address: activeDexRouter,
        abi: dexRouterAbi,
        functionName: swapCall.functionName,
        args: swapCall.args,
        value: swapCall.value,
      },
    });
    if (hash) {
      toast.show("Swap confirmed", `${amountText} ${assetIn.symbol} was settled on LitVM.`, "success");
      setAmountText("");
      void nativeBalance.refetch(); void tokenBalance.refetch();
    }
  }

  const submitDisabled = !importedContractsReady || !routeConfigured || !routeStateReady || routePaused
    || quoteFetching || !executableQuoteCurrent || !amountIn || !amountOut || Boolean(validation)
    || tx.pending;
  const submitLabel = swapButtonLabel({
    importsReady: importedContractsReady,
    infrastructureConfigured,
    payImportStatus: importedPay.status,
    pending: tx.pending,

    quoteFetching,
    receiveImportStatus: importedReceive.status,
    routeConfigured,
    routeError: Boolean(swapRoute.error),
    routeKind: swapRoute.kind,
    routePaused,
    routeStateReady,
  });

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
          value={amountOut ? formatTokenAmount(amountOut, assetOut?.decimals ?? 18).replace(/,/g, "") : ""}
          busy={quoteFetching}
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
        {executionImpactBps !== undefined && executionImpactBps >= 500n ? (
          <div className="fi-inline-state fi-inline-warning" role="alert">
            <div>
              <strong>High execution impact</strong>
              <p>The current route is {executionImpactLabel} below the fee-free spot value. Reduce the amount or wait for deeper liquidity.</p>
            </div>
          </div>
        ) : null}
        {amountIn ? (
          <dl className="fi-form-details">
            {routeLabel ? (
              <div>
                <dt>Route</dt>
                <dd>{routeLabel}</dd>
              </div>
            ) : null}
            <div><dt>Rate</dt><dd>{rate ? `${rate} ${assetOut?.symbol ?? ""} / ${assetIn?.symbol ?? ""}` : "--"}</dd></div>
            <div><dt>Route fee</dt><dd>{feeLabel}</dd></div>
            <div><dt>Execution impact</dt><dd data-tone={executionImpactTone}>{executionImpactLabel}</dd></div>
            <div><dt>Minimum received</dt><dd>{minimumReceived ? `${formatTokenAmount(minimumReceived, assetOut?.decimals ?? 18)} ${assetOut?.symbol ?? ""}` : "--"}</dd></div>
          </dl>
        ) : null}
        <details className="fi-settings-details">
          <summary><span>Settings</span><strong>{Number(slippageBps) / 100}% slippage</strong></summary>
          <SlippageControl value={slippageBps} onChange={setSlippageBps} />
        </details>
        {!isConnected ? (
          <ConnectWalletButton />
        ) : (
          <button type="submit" className="fi-button fi-button-primary fi-button-block" disabled={submitDisabled}>
            {submitLabel}
          </button>
        )}
        <TransactionStatus phase={tx.phase} message={tx.message} hash={tx.hash} />
      </form>
    </section>
  );
}
