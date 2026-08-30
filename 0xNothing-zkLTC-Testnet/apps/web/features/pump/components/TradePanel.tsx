"use client";

import { useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { formatUnits, maxUint256, parseUnits } from "viem";
import {
  useAccount,
  usePublicClient,
  useReadContract,
  useSwitchChain,
  useWriteContract,
} from "wagmi";
import { nusdAbi, pumpTokenAbi, zeroXPumpAbi } from "@/features/pump/abis";
import {
  NUSD_CONFIGURED,
  PUMP_BPS_DENOMINATOR,
  PUMP_CHAIN_ID,
  PUMP_CONFIGURED,
  PUMP_FACTORY_ADDRESS,
  PUMP_NUSD_ADDRESS,
} from "@/features/pump/config";
import { formatCompactNumber } from "@/features/pump/format";
import type { PumpMarket } from "@/features/pump/types";
import { useToast } from "@/components/Toast";
import { invalidateAfterPumpTrade } from "@/lib/liveData";
import { releaseAction, tryAcquireAction } from "@/lib/actionLock";

type TradeMode = "buy" | "sell";

function parseTradeAmount(value: string): bigint {
  try {
    return value && Number(value) > 0 ? parseUnits(value, 18) : 0n;
  } catch {
    return 0n;
  }
}

function displayAmount(value: bigint): string {
  return formatCompactNumber(Number(formatUnits(value, 18)), 6);
}

export function TradePanel({ market, onComplete }: { market: PumpMarket; onComplete?: () => void }) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const { address, isConnected, chainId } = useAccount();
  const publicClient = usePublicClient();
  const { switchChain } = useSwitchChain();
  const { writeContractAsync } = useWriteContract();
  const submitLockRef = useRef(false);
  const [mode, setMode] = useState<TradeMode>(market.status === "READY" ? "sell" : "buy");
  const [amount, setAmount] = useState("");
  const [slippageBps, setSlippageBps] = useState(100n);
  const [pending, setPending] = useState(false);
  const amountWei = useMemo(() => parseTradeAmount(amount), [amount]);
  const configured = PUMP_CONFIGURED && NUSD_CONFIGURED;

  const buyQuote = useReadContract({
    address: PUMP_FACTORY_ADDRESS,
    abi: zeroXPumpAbi,
    functionName: "quoteBuy",
    args: [market.tokenAddress, amountWei],
    query: { enabled: configured && mode === "buy" && amountWei > 0n && market.status === "TRADING" },
  });
  const sellQuote = useReadContract({
    address: PUMP_FACTORY_ADDRESS,
    abi: zeroXPumpAbi,
    functionName: "quoteSell",
    args: [market.tokenAddress, amountWei],
    query: { enabled: configured && mode === "sell" && amountWei > 0n && market.status !== "GRADUATED" },
  });
  const nusdBalance = useReadContract({
    address: PUMP_NUSD_ADDRESS,
    abi: nusdAbi,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    query: { enabled: Boolean(configured && address) },
  });
  const tokenBalance = useReadContract({
    address: market.tokenAddress,
    abi: pumpTokenAbi,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    query: { enabled: Boolean(configured && address) },
  });
  const nusdAllowance = useReadContract({
    address: PUMP_NUSD_ADDRESS,
    abi: nusdAbi,
    functionName: "allowance",
    args: address ? [address, PUMP_FACTORY_ADDRESS] : undefined,
    query: { enabled: Boolean(configured && address) },
  });
  const tokenAllowance = useReadContract({
    address: market.tokenAddress,
    abi: pumpTokenAbi,
    functionName: "allowance",
    args: address ? [address, PUMP_FACTORY_ADDRESS] : undefined,
    query: { enabled: Boolean(configured && address) },
  });

  const quoteOutput = mode === "buy" ? (buyQuote.data?.[0] ?? 0n) : (sellQuote.data?.[1] ?? 0n);
  const quoteFee = mode === "buy" ? (buyQuote.data?.[3] ?? 0n) : (sellQuote.data?.[2] ?? 0n);
  const actualInput = mode === "buy" ? (buyQuote.data?.[2] ?? amountWei) : amountWei;
  const sourceBalance = mode === "buy" ? (nusdBalance.data ?? 0n) : (tokenBalance.data ?? 0n);
  const sourceAllowance = mode === "buy" ? (nusdAllowance.data ?? 0n) : (tokenAllowance.data ?? 0n);
  const needsApproval = actualInput > sourceAllowance;
  const activeQuote = mode === "buy" ? buyQuote : sellQuote;
  // Only a quote that has no value yet blocks the trade. Both quote reads sit in
  // the block-sync allowlist, so `isFetching` went true on every new block and
  // the submit button disabled itself — with a perfectly good quote on screen —
  // for the length of an RPC round trip roughly every ten seconds. `isLoading`
  // stays false while a query is disabled, so an empty amount cannot pin the
  // button either, and a new amount still gates it until its quote arrives.
  const quotePending = activeQuote.isLoading;
  const quoteError = activeQuote.error;
  const tradeAllowed = market.status === "TRADING" || (market.status === "READY" && mode === "sell");

  const refresh = async () => {
    await Promise.all([
      nusdBalance.refetch(),
      tokenBalance.refetch(),
      nusdAllowance.refetch(),
      tokenAllowance.refetch(),
      activeQuote.refetch(),
      invalidateAfterPumpTrade(queryClient, market.tokenAddress),
    ]);
    onComplete?.();
  };

  const submit = async () => {
    if (!configured) {
      toast.info("Contracts not configured", "Set the Pump and NUSD deployment addresses first.");
      return;
    }
    if (!isConnected || !address) {
      toast.warning("Connect wallet", "Connect a wallet to trade this market.");
      return;
    }
    if (chainId !== PUMP_CHAIN_ID) {
      switchChain({ chainId: PUMP_CHAIN_ID });
      return;
    }
    if (!publicClient) {
      toast.error("RPC unavailable", "Refresh the page and try again.");
      return;
    }
    if (!tradeAllowed) {
      toast.info(
        market.status === "GRADUATED" ? "Curve closed" : "$6,000 market cap reached",
        market.status === "GRADUATED"
          ? "Trading on this bonding curve has ended."
          : "Buys pause at READY. A sell can reopen the bonding curve.",
      );
      return;
    }
    if (amountWei <= 0n || quoteOutput <= 0n) {
      toast.warning("Enter an amount", "Enter a valid trade amount and wait for a quote.");
      return;
    }
    if (actualInput > sourceBalance) {
      toast.warning("Insufficient balance", `Your ${mode === "buy" ? "NUSD" : market.symbol} balance is too low.`);
      return;
    }
    if (!tryAcquireAction(submitLockRef)) return;

    try {
      setPending(true);
      if (needsApproval) {
        const hash = mode === "buy"
          ? await writeContractAsync({ address: PUMP_NUSD_ADDRESS, abi: nusdAbi, functionName: "approve", args: [PUMP_FACTORY_ADDRESS, maxUint256] })
          : await writeContractAsync({ address: market.tokenAddress, abi: pumpTokenAbi, functionName: "approve", args: [PUMP_FACTORY_ADDRESS, maxUint256] });
        const receipt = await publicClient.waitForTransactionReceipt({ hash });
        if (receipt.status !== "success") throw new Error("Token approval reverted");
        toast.info("Approval confirmed", "Confirm the trade transaction in your wallet.");
      }

      const minimumOutput = (quoteOutput * (PUMP_BPS_DENOMINATOR - slippageBps)) / PUMP_BPS_DENOMINATOR;
      const deadline = BigInt(Math.floor(Date.now() / 1000) + 20 * 60);
      const hash = mode === "buy"
        ? await writeContractAsync({
            address: PUMP_FACTORY_ADDRESS,
            abi: zeroXPumpAbi,
            functionName: "buy",
            args: [market.tokenAddress, amountWei, minimumOutput, deadline],
          })
        : await writeContractAsync({
            address: PUMP_FACTORY_ADDRESS,
            abi: zeroXPumpAbi,
            functionName: "sell",
            args: [market.tokenAddress, amountWei, minimumOutput, deadline],
          });
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") throw new Error("Trade reverted");
      toast.success(`${mode === "buy" ? "Buy" : "Sell"} confirmed`, "The trade settled on the 0xPump curve.");
      setAmount("");
      await refresh();
    } catch (error) {
      toast.handleError(error, "Trade failed");
    } finally {
      releaseAction(submitLockRef);
      setPending(false);
    }
  };

  const buttonLabel = market.status === "GRADUATED"
    ? "Graduated to DEX"
    : market.status === "READY" && mode === "buy" ? "Buy paused at READY"
    : pending ? "Confirming transaction"
    : needsApproval ? `Approve once and ${mode === "buy" ? "buy" : "sell"}`
    : mode === "buy" ? `Buy ${market.symbol}` : `Sell ${market.symbol}`;

  return (
    <aside className="pump-panel pump-trade-panel">
      <div className="pump-segmented pump-trade-tabs" role="group" aria-label="Trade side">
        <button type="button" disabled={market.status !== "TRADING"} className={mode === "buy" ? "active buy" : ""} aria-pressed={mode === "buy"} onClick={() => { setMode("buy"); setAmount(""); }}>Buy</button>
        <button type="button" disabled={market.status === "GRADUATED"} className={mode === "sell" ? "active sell" : ""} aria-pressed={mode === "sell"} onClick={() => { setMode("sell"); setAmount(""); }}>Sell</button>
      </div>

      <label className="pump-amount-field">
        <span><span>{mode === "buy" ? "Maximum spend" : "You pay"}</span><button type="button" onClick={() => setAmount(formatUnits(sourceBalance, 18))}>Max {displayAmount(sourceBalance)}</button></span>
        <span><input inputMode="decimal" value={amount} onChange={(event) => setAmount(event.target.value)} placeholder="0.0" /><strong>{mode === "buy" ? "NUSD" : market.symbol}</strong></span>
      </label>

      <div className="pump-quote-arrow" aria-hidden="true">&darr;</div>

      <div className="pump-amount-field pump-amount-output">
        <span><span>You receive</span><small>{quotePending ? "Quoting" : "Estimated"}</small></span>
        <span><strong>{displayAmount(quoteOutput)}</strong><b>{mode === "buy" ? market.symbol : "NUSD"}</b></span>
      </div>

      <div className="pump-trade-details">
        {mode === "buy" ? <div><span>Actual spend</span><strong>${displayAmount(actualInput)}</strong></div> : null}
        <div><span>Protocol fee</span><strong>${displayAmount(quoteFee)} (0.1%)</strong></div>
        <div><span>Slippage</span><span className="pump-inline-options">{[50n, 100n, 200n].map((value) => <button key={value.toString()} type="button" className={slippageBps === value ? "active" : ""} aria-pressed={slippageBps === value} onClick={() => setSlippageBps(value)}>{Number(value) / 100}%</button>)}</span></div>
        {mode === "buy" && buyQuote.data?.[4] ? <p>This buy reaches the $6,000 READY target.</p> : null}
      </div>

      {quoteError ? <p className="pump-inline-error">Quote unavailable. <button type="button" onClick={() => void activeQuote.refetch()}>Retry</button></p> : null}

      {market.status === "READY" ? <p className="pump-form-hint">Buys are paused at the $6,000 market-cap target. Selling remains available and reopens the curve.</p> : null}
      <button type="button" className="pump-button pump-button-primary pump-button-large pump-button-full" disabled={pending || !configured || quotePending || Boolean(quoteError) || !tradeAllowed} onClick={() => void submit()}>{buttonLabel}</button>
      {!configured ? <p className="pump-form-hint">Trading activates after deployment addresses are configured.</p> : null}
    </aside>
  );
}
