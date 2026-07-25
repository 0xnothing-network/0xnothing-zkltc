"use client";

import { useMemo, useState } from "react";
import { formatUnits, parseUnits } from "viem";
import {
  useAccount,
  useBalance,
  usePublicClient,
  useReadContract,
  useSwitchChain,
  useWriteContract,
} from "wagmi";
import { useToast } from "@/components/Toast";
import { diaOracleAdapterAbi, nusdAbi } from "@/features/pump/abis";
import {
  NUSD_CONFIGURED,
  PUMP_CHAIN_ID,
  PUMP_NUSD_ADDRESS,
  ZERO_ADDRESS,
} from "@/features/pump/config";
import {
  formatCompactNumber,
  formatRelativeTime,
} from "@/features/pump/format";

type OracleMode = "mint" | "redeem";

const BPS_DENOMINATOR = 10_000n;
const SLIPPAGE_BPS = 50n;

function parseAmount(value: string): bigint {
  try {
    const parsed = parseUnits(value.trim(), 18);
    return parsed > 0n ? parsed : 0n;
  } catch {
    return 0n;
  }
}

function formatInputAmount(value: bigint): string {
  return formatUnits(value, 18).replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
}

function minimumOutput(quote: bigint): bigint {
  return (quote * (BPS_DENOMINATOR - SLIPPAGE_BPS)) / BPS_DENOMINATOR;
}

function displayWad(value: bigint | undefined, pending: boolean, digits = 2): string {
  if (pending) return "...";
  if (value === undefined) return "--";
  return formatCompactNumber(Number(formatUnits(value, 18)), digits);
}

function displayUsdWad(value: bigint | undefined, pending: boolean, digits = 2): string {
  const amount = displayWad(value, pending, digits);
  return amount === "..." || amount === "--" ? amount : `$${amount}`;
}

export function NusdOraclePanel() {
  const toast = useToast();
  const { address, isConnected, chainId } = useAccount();
  const publicClient = usePublicClient({ chainId: PUMP_CHAIN_ID });
  const { switchChain } = useSwitchChain();
  const { writeContractAsync } = useWriteContract();
  const [mode, setMode] = useState<OracleMode>("mint");
  const [mintAmount, setMintAmount] = useState("");
  const [redeemAmount, setRedeemAmount] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  const configured = NUSD_CONFIGURED;
  const wrongChain = isConnected && chainId !== PUMP_CHAIN_ID;
  const collateralWei = useMemo(() => parseAmount(mintAmount), [mintAmount]);
  const nusdWei = useMemo(() => parseAmount(redeemAmount), [redeemAmount]);

  const nativeBalance = useBalance({
    address,
    chainId: PUMP_CHAIN_ID,
    query: { enabled: Boolean(address), refetchInterval: 15_000 },
  });
  const nusdBalance = useReadContract({
    address: PUMP_NUSD_ADDRESS,
    abi: nusdAbi,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    chainId: PUMP_CHAIN_ID,
    query: { enabled: Boolean(configured && address), refetchInterval: 15_000 },
  });
  const totalSupply = useReadContract({
    address: PUMP_NUSD_ADDRESS,
    abi: nusdAbi,
    functionName: "totalSupply",
    chainId: PUMP_CHAIN_ID,
    query: { enabled: configured, refetchInterval: 15_000 },
  });
  const reserve = useReadContract({
    address: PUMP_NUSD_ADDRESS,
    abi: nusdAbi,
    functionName: "totalCollateralWei",
    chainId: PUMP_CHAIN_ID,
    query: { enabled: configured, refetchInterval: 15_000 },
  });
  const reserveValue = useReadContract({
    address: PUMP_NUSD_ADDRESS,
    abi: nusdAbi,
    functionName: "reserveValueNusd",
    chainId: PUMP_CHAIN_ID,
    query: { enabled: configured, refetchInterval: 15_000 },
  });
  const supplyCeiling = useReadContract({
    address: PUMP_NUSD_ADDRESS,
    abi: nusdAbi,
    functionName: "supplyCeilingNusd",
    chainId: PUMP_CHAIN_ID,
    query: { enabled: configured, refetchInterval: 15_000 },
  });
  const mintPaused = useReadContract({
    address: PUMP_NUSD_ADDRESS,
    abi: nusdAbi,
    functionName: "mintPaused",
    chainId: PUMP_CHAIN_ID,
    query: { enabled: configured, refetchInterval: 15_000 },
  });
  const redeemPaused = useReadContract({
    address: PUMP_NUSD_ADDRESS,
    abi: nusdAbi,
    functionName: "redeemPaused",
    chainId: PUMP_CHAIN_ID,
    query: { enabled: configured, refetchInterval: 15_000 },
  });
  const oracle = useReadContract({
    address: PUMP_NUSD_ADDRESS,
    abi: nusdAbi,
    functionName: "oracle",
    chainId: PUMP_CHAIN_ID,
    query: { enabled: configured, refetchInterval: 15_000 },
  });
  const oracleAddress = oracle.data ?? ZERO_ADDRESS;
  const oraclePrice = useReadContract({
    address: oracleAddress,
    abi: diaOracleAdapterAbi,
    functionName: "readPriceWad",
    chainId: PUMP_CHAIN_ID,
    query: {
      enabled: configured && oracleAddress !== ZERO_ADDRESS,
      refetchInterval: 15_000,
    },
  });
  const oracleFresh = useReadContract({
    address: oracleAddress,
    abi: diaOracleAdapterAbi,
    functionName: "isFresh",
    chainId: PUMP_CHAIN_ID,
    query: {
      enabled: configured && oracleAddress !== ZERO_ADDRESS,
      refetchInterval: 15_000,
    },
  });
  const mintQuote = useReadContract({
    address: PUMP_NUSD_ADDRESS,
    abi: nusdAbi,
    functionName: "quoteMint",
    args: [collateralWei],
    chainId: PUMP_CHAIN_ID,
    query: { enabled: configured && collateralWei > 0n },
  });
  const redeemQuote = useReadContract({
    address: PUMP_NUSD_ADDRESS,
    abi: nusdAbi,
    functionName: "quoteRedeem",
    args: [nusdWei],
    chainId: PUMP_CHAIN_ID,
    query: { enabled: configured && nusdWei > 0n },
  });

  const oraclePriceWad = oraclePrice.data?.[0];
  const oracleUpdatedAt = Number(oraclePrice.data?.[1] ?? 0n);
  const oracleChecking = configured && (
    oracle.isPending
    || (oracleAddress !== ZERO_ADDRESS && (oraclePrice.isPending || oracleFresh.isPending))
  );
  const oracleReady = Boolean(
    oraclePriceWad
      && oraclePriceWad > 0n
      && oracleFresh.data !== false
      && !oracleFresh.error,
  );
  const oracleStatus = !configured
    ? "offline"
    : oracleChecking
      ? "loading"
      : oracleReady
        ? "live"
        : "error";

  const amountIn = mode === "mint" ? collateralWei : nusdWei;
  const quote = mode === "mint" ? mintQuote.data : redeemQuote.data;
  const quotePending = amountIn > 0n
    && (mode === "mint" ? mintQuote.isPending : redeemQuote.isPending);
  const quoteError = mode === "mint" ? mintQuote.error : redeemQuote.error;
  const minOut = minimumOutput(quote ?? 0n);
  const metricsReadFailed = Boolean(
    totalSupply.error || reserve.error || reserveValue.error || supplyCeiling.error,
  );
  const actionPaused = mode === "mint" ? mintPaused.data : redeemPaused.data;
  const pausePending = mode === "mint" ? mintPaused.isPending : redeemPaused.isPending;
  const balancePending = mode === "mint" ? nativeBalance.isPending : nusdBalance.isPending;
  const amountExceedsBalance = mode === "mint"
    ? nativeBalance.data !== undefined && collateralWei > nativeBalance.data.value
    : nusdBalance.data !== undefined && nusdWei > nusdBalance.data;
  const actionError = amountExceedsBalance
    ? mode === "mint"
      ? "Amount exceeds your zkLTC balance."
      : "Amount exceeds your NUSD balance."
    : actionPaused
      ? mode === "mint"
        ? "Minting is temporarily paused."
        : "Redemption is temporarily paused."
      : quoteError
        ? "A fresh DIA quote is unavailable."
        : null;
  const actionPending = amountIn > 0n && (quotePending || pausePending || balancePending);
  const actionDisabled = isSubmitting
    || !configured
    || (!wrongChain && isConnected && (
      amountIn === 0n
      || actionPending
      || quote === undefined
      || Boolean(actionError)
    ));

  const refresh = async () => {
    await Promise.all([
      nativeBalance.refetch(),
      nusdBalance.refetch(),
      totalSupply.refetch(),
      reserve.refetch(),
      reserveValue.refetch(),
      supplyCeiling.refetch(),
      mintPaused.refetch(),
      redeemPaused.refetch(),
      oraclePrice.refetch(),
      oracleFresh.refetch(),
    ]);
  };

  const guard = (): boolean => {
    if (!configured) {
      toast.info("NUSD not configured", "Set the current NUSD deployment address first.");
      return false;
    }
    if (!isConnected || !address) {
      toast.warning("Connect wallet", "Use the wallet control above before continuing.");
      return false;
    }
    if (chainId !== PUMP_CHAIN_ID) {
      switchChain({ chainId: PUMP_CHAIN_ID });
      return false;
    }
    if (!publicClient) {
      toast.error("RPC unavailable", "Refresh the page and try again.");
      return false;
    }
    return true;
  };

  const submit = async () => {
    if (!guard() || !address || !publicClient || amountIn === 0n || quote === undefined || actionError) {
      return;
    }

    try {
      setIsSubmitting(true);
      const hash = mode === "mint"
        ? await (async () => {
            await publicClient.simulateContract({
              account: address,
              address: PUMP_NUSD_ADDRESS,
              abi: nusdAbi,
              functionName: "mintAtOracle",
              args: [minOut, address],
              value: collateralWei,
            });
            return writeContractAsync({
              address: PUMP_NUSD_ADDRESS,
              abi: nusdAbi,
              functionName: "mintAtOracle",
              args: [minOut, address],
              value: collateralWei,
            });
          })()
        : await (async () => {
            await publicClient.simulateContract({
              account: address,
              address: PUMP_NUSD_ADDRESS,
              abi: nusdAbi,
              functionName: "redeemAtOracle",
              args: [nusdWei, minOut, address],
            });
            return writeContractAsync({
              address: PUMP_NUSD_ADDRESS,
              abi: nusdAbi,
              functionName: "redeemAtOracle",
              args: [nusdWei, minOut, address],
            });
          })();

      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") throw new Error("NUSD transaction reverted");
      await refresh();
      if (mode === "mint") {
        setMintAmount("");
        toast.success("NUSD minted", "NUSD is now available in your wallet.");
      } else {
        setRedeemAmount("");
        toast.success("NUSD redeemed", "zkLTC was returned to your wallet.");
      }
    } catch (error) {
      toast.handleError(error, mode === "mint" ? "Could not mint NUSD" : "Could not redeem NUSD");
    } finally {
      setIsSubmitting(false);
    }
  };

  const actionLabel = !configured
    ? "NUSD not configured"
    : !isConnected
      ? "Connect wallet above"
      : wrongChain
        ? "Switch to LitVM"
        : isSubmitting
          ? "Confirming transaction"
          : actionPending
            ? "Getting quote"
            : mode === "mint"
              ? "Mint NUSD"
              : "Redeem for zkLTC";

  return (
    <section className="pump-panel pump-vault pump-oracle-nusd">
      <div className="pump-panel-heading pump-vault-heading">
        <div><span className="pump-eyebrow">zkLTC reserve</span><h2>Mint or redeem NUSD</h2></div>
        <span className="pump-vault-oracle-status" data-state={oracleStatus}>
          DIA {oracleStatus === "live" ? "LIVE" : oracleStatus === "loading" ? "CHECKING" : oracleStatus === "error" ? "UNAVAILABLE" : "NOT CONFIGURED"}
        </span>
      </div>

      <div className="pump-vault-oracle-strip">
        <div><span>zkLTC / USD</span><strong>{oracleChecking ? "..." : oracleReady ? `${displayWad(oraclePriceWad, false, 4)} USD` : "--"}</strong></div>
        <div><span>DIA updated</span><strong>{oracleUpdatedAt ? formatRelativeTime(oracleUpdatedAt) : "--"}</strong></div>
        <div><span>Reserve value</span><strong>{displayUsdWad(reserveValue.data, reserveValue.isPending, 2)}</strong></div>
        <div><span>Supply ceiling</span><strong>{displayUsdWad(supplyCeiling.data, supplyCeiling.isPending, 2)}</strong></div>
      </div>

      <div className="pump-vault-metrics">
        <div><span>Your zkLTC</span><strong>{displayWad(nativeBalance.data?.value, nativeBalance.isPending, 4)} zkLTC</strong></div>
        <div><span>Your NUSD</span><strong>{displayUsdWad(nusdBalance.data, nusdBalance.isPending, 2)}</strong></div>
        <div><span>Protocol reserve</span><strong>{displayWad(reserve.data, reserve.isPending, 4)} zkLTC</strong></div>
        <div><span>NUSD supply</span><strong>{displayUsdWad(totalSupply.data, totalSupply.isPending, 2)}</strong></div>
      </div>

      {!configured ? <p className="pump-vault-alert">Direct mint and redeem activate after the NUSD deployment address is configured.</p> : null}
      {configured && !oracleChecking && !oracleReady ? <p className="pump-vault-alert warning">DIA price unavailable: mint and redeem are paused until a fresh quote is available.</p> : null}
      {metricsReadFailed ? <p className="pump-vault-alert warning">Protocol metrics could not be refreshed. <button type="button" onClick={() => void refresh()}>Retry</button></p> : null}

      <div className="pump-segmented pump-vault-tabs" role="group" aria-label="NUSD action">
        <button type="button" className={mode === "mint" ? "active" : ""} aria-pressed={mode === "mint"} onClick={() => setMode("mint")}>Mint</button>
        <button type="button" className={mode === "redeem" ? "active" : ""} aria-pressed={mode === "redeem"} onClick={() => setMode("redeem")}>Redeem</button>
      </div>

      <div className="pump-vault-workspace">
        <div className="pump-vault-form">
          {mode === "mint" ? (
            <div className="pump-field pump-vault-step">
              <div className="pump-vault-field-head"><label htmlFor="nusd-mint-input"><span>01</span> zkLTC to deposit</label><small>Wallet {displayWad(nativeBalance.data?.value, nativeBalance.isPending, 4)} zkLTC</small></div>
              <div className="pump-vault-token-field"><input id="nusd-mint-input" inputMode="decimal" value={mintAmount} onChange={(event) => setMintAmount(event.target.value)} placeholder="0.0" /><strong>zkLTC</strong></div>
            </div>
          ) : (
            <div className="pump-field pump-vault-step">
              <div className="pump-vault-field-head"><label htmlFor="nusd-redeem-input"><span>01</span> NUSD to redeem</label><button type="button" disabled={!nusdBalance.data} onClick={() => setRedeemAmount(formatInputAmount(nusdBalance.data ?? 0n))}>MAX {displayUsdWad(nusdBalance.data, nusdBalance.isPending, 2)}</button></div>
              <div className="pump-vault-token-field"><input id="nusd-redeem-input" inputMode="decimal" value={redeemAmount} onChange={(event) => setRedeemAmount(event.target.value)} placeholder="0.0" /><strong>NUSD</strong></div>
            </div>
          )}

          {actionError ? <p className="pump-vault-inline-error">{actionError}</p> : null}
          <button type="button" className="pump-button pump-button-primary pump-button-large" disabled={actionDisabled} onClick={() => void submit()}>{actionLabel}</button>
        </div>

        <aside className="pump-vault-preview" aria-live="polite">
          <span className="pump-eyebrow">You receive</span>
          <strong className="pump-vault-preview-amount">
            {mode === "mint"
              ? displayUsdWad(quote, quotePending, 2)
              : displayWad(quote, quotePending, 6)}
            {mode === "redeem" ? <small>zkLTC</small> : null}
          </strong>
          <dl>
            <div><dt>Minimum received</dt><dd>{mode === "mint"
              ? displayUsdWad(quote === undefined ? undefined : minOut, quotePending, 2)
              : `${displayWad(quote === undefined ? undefined : minOut, quotePending, 6)} zkLTC`}</dd></div>
            <div><dt>Price source</dt><dd>DIA oracle</dd></div>
            <div><dt>Slippage tolerance</dt><dd>0.50%</dd></div>
          </dl>
        </aside>
      </div>
    </section>
  );
}
