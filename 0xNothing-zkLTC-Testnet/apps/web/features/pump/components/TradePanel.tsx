"use client";

import { useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { formatUnits, maxUint256, parseUnits } from "viem";
import {
  useAccount,
  useConfig,
  usePublicClient,
  useReadContract,
  useSwitchChain,
  useWriteContract,
} from "wagmi";
import { createPumpWalletGuard } from "@/features/pump/walletSession";
import { waitForProtocolReceipt } from "@/lib/transactionReceipt";
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
import { useDebouncedValue } from "@/lib/useDebouncedValue";

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

function readyExitIsOpen(readyAt: bigint | undefined, delay: bigint | undefined, nowSec = Math.floor(Date.now() / 1000)): boolean {
  if (readyAt === undefined || delay === undefined) return false;
  return BigInt(nowSec) >= readyAt + delay;
}

function readySellsAreOpen(
  graduationPossible: boolean | undefined,
  readyAt: bigint | undefined,
  delay: bigint | undefined,
  nowSec = Math.floor(Date.now() / 1000),
): boolean {
  if (graduationPossible === false) return true;
  return readyExitIsOpen(readyAt, delay, nowSec);
}

function formatRemaining(opensAt: bigint, nowSec = Math.floor(Date.now() / 1000)): string {
  const seconds = Number(opensAt) - nowSec;
  if (!Number.isFinite(seconds) || seconds <= 0) return "now";
  if (seconds < 3600) return `${Math.max(1, Math.ceil(seconds / 60))}m`;
  if (seconds < 86_400) return `${Math.max(1, Math.ceil(seconds / 3600))}h`;
  return `${Math.max(1, Math.ceil(seconds / 86_400))}d`;
}

export function TradePanel({ market, onComplete }: { market: PumpMarket; onComplete?: () => void }) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const { address, isConnected, chainId } = useAccount();
  const walletConfig = useConfig();
  const publicClient = usePublicClient({ chainId: PUMP_CHAIN_ID });
  const { switchChain } = useSwitchChain();
  const { writeContractAsync } = useWriteContract();
  const submitLockRef = useRef(false);
  const [mode, setMode] = useState<TradeMode>(market.status === "READY" ? "sell" : "buy");
  const [amount, setAmount] = useState("");
  const [slippageBps, setSlippageBps] = useState(100n);
  const [pending, setPending] = useState(false);
  const typedAmountWei = useMemo(() => parseTradeAmount(amount), [amount]);
  // The curve quote keys on the amount, so an undebounced field asked the chain
  // to price every prefix of the number being typed. Settle first, quote once.
  const { value: amountWei, pending: amountSettling } = useDebouncedValue(typedAmountWei);
  const configured = PUMP_CONFIGURED && NUSD_CONFIGURED;

  const pumpPaused = useReadContract({
    chainId: PUMP_CHAIN_ID,
    address: PUMP_FACTORY_ADDRESS,
    abi: zeroXPumpAbi,
    functionName: "paused",
    query: { enabled: configured },
  });
  const readyAt = useReadContract({
    chainId: PUMP_CHAIN_ID,
    address: PUMP_FACTORY_ADDRESS,
    abi: zeroXPumpAbi,
    functionName: "readyAt",
    args: [market.tokenAddress],
    query: { enabled: configured && market.status === "READY" },
  });
  const readyExitDelay = useReadContract({
    chainId: PUMP_CHAIN_ID,
    address: PUMP_FACTORY_ADDRESS,
    abi: zeroXPumpAbi,
    functionName: "readyExitDelay",
    query: { enabled: configured && market.status === "READY" },
  });
  const graduationPossible = useReadContract({
    chainId: PUMP_CHAIN_ID,
    address: PUMP_FACTORY_ADDRESS,
    abi: zeroXPumpAbi,
    functionName: "graduationPossible",
    query: { enabled: configured && market.status === "READY" },
  });
  const exitOpensAt = market.status === "READY" && graduationPossible.data !== false
    && readyAt.data !== undefined && readyExitDelay.data !== undefined
    ? readyAt.data + readyExitDelay.data
    : undefined;
  const exitOpen = market.status === "READY" && readySellsAreOpen(graduationPossible.data, readyAt.data, readyExitDelay.data);
  const buyAllowed = market.status === "TRADING" && pumpPaused.data !== true;
  const sellAllowed = market.status === "TRADING" || exitOpen;
  const buyQuote = useReadContract({
    chainId: PUMP_CHAIN_ID,
    address: PUMP_FACTORY_ADDRESS,
    abi: zeroXPumpAbi,
    functionName: "quoteBuy",
    args: [market.tokenAddress, amountWei],
    account: address,
    query: { enabled: configured && mode === "buy" && amountWei > 0n && buyAllowed },
  });
  const sellQuote = useReadContract({
    chainId: PUMP_CHAIN_ID,
    address: PUMP_FACTORY_ADDRESS,
    abi: zeroXPumpAbi,
    functionName: "quoteSell",
    args: [market.tokenAddress, amountWei],
    query: { enabled: configured && mode === "sell" && amountWei > 0n && sellAllowed },
  });
  const nusdBalance = useReadContract({
    chainId: PUMP_CHAIN_ID,
    address: PUMP_NUSD_ADDRESS,
    abi: nusdAbi,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    query: { enabled: Boolean(configured && address) },
  });
  const tokenBalance = useReadContract({
    chainId: PUMP_CHAIN_ID,
    address: market.tokenAddress,
    abi: pumpTokenAbi,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    query: { enabled: Boolean(configured && address) },
  });
  const nusdAllowance = useReadContract({
    chainId: PUMP_CHAIN_ID,
    address: PUMP_NUSD_ADDRESS,
    abi: nusdAbi,
    functionName: "allowance",
    args: address ? [address, PUMP_FACTORY_ADDRESS] : undefined,
    query: { enabled: Boolean(configured && address) },
  });
  const tokenAllowance = useReadContract({
    chainId: PUMP_CHAIN_ID,
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
  // The settling window counts as pending for the same reason: the quote on
  // screen belongs to the previous amount, not the one now in the field.
  const quotePending = amountSettling || activeQuote.isLoading;
  const quoteError = activeQuote.error;
  const tradeAllowed = mode === "buy" ? buyAllowed : sellAllowed;

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
        market.status === "GRADUATED" ? "Curve closed" : market.status === "READY" ? "$6,000 market cap reached" : "Buys paused",
        market.status === "GRADUATED"
          ? "Trading on this bonding curve has ended."
          : market.status === "READY" && !exitOpen
            ? "Trading is frozen so this market can graduate. Sells reopen after the exit delay if graduation never happens."
            : "The launchpad is paused. Selling remains available.",
      );
      return;
    }
    if (quotePending || quoteError) {
      toast.warning("Quote not ready", "Wait for a quote for the amount currently entered.");
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
      const assertWalletUnchanged = createPumpWalletGuard(walletConfig, address);
      assertWalletUnchanged();
      if (needsApproval) {
        const hash = mode === "buy"
          ? await writeContractAsync({ account: address, chainId: PUMP_CHAIN_ID, address: PUMP_NUSD_ADDRESS, abi: nusdAbi, functionName: "approve", args: [PUMP_FACTORY_ADDRESS, maxUint256] })
          : await writeContractAsync({ account: address, chainId: PUMP_CHAIN_ID, address: market.tokenAddress, abi: pumpTokenAbi, functionName: "approve", args: [PUMP_FACTORY_ADDRESS, maxUint256] });
        await waitForProtocolReceipt(publicClient, hash);
        toast.info("Approval confirmed", "Confirm the trade transaction in your wallet.");
      }

      const minimumOutput = (quoteOutput * (PUMP_BPS_DENOMINATOR - slippageBps)) / PUMP_BPS_DENOMINATOR;
      const deadline = BigInt(Math.floor(Date.now() / 1000) + 20 * 60);
      assertWalletUnchanged();
      const request = {
        account: address,
        chainId: PUMP_CHAIN_ID,
        address: PUMP_FACTORY_ADDRESS,
        abi: zeroXPumpAbi,
        functionName: mode === "buy" ? "buy" : "sell",
        args: [market.tokenAddress, amountWei, minimumOutput, deadline],
      } as const;
      await publicClient.simulateContract(request);
      assertWalletUnchanged();
      const hash = await writeContractAsync(request);
      await waitForProtocolReceipt(publicClient, hash);
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
    : market.status === "READY" && !exitOpen ? "Awaiting graduation"
    : market.status === "READY" && mode === "buy" ? "Buy paused at READY"
    : pumpPaused.data === true && mode === "buy" ? "Buys paused"
    : pending ? "Confirming transaction"
    : needsApproval ? `Approve once and ${mode === "buy" ? "buy" : "sell"}`
    : mode === "buy" ? `Buy ${market.symbol}` : `Sell ${market.symbol}`;

  return (
    <aside className="pump-panel pump-trade-panel">
      <div className="pump-segmented pump-trade-tabs" role="group" aria-label="Trade side">
        <button type="button" disabled={pending || !buyAllowed} className={mode === "buy" ? "active buy" : ""} aria-pressed={mode === "buy"} onClick={() => { setMode("buy"); setAmount(""); }}>Buy</button>
        <button type="button" disabled={pending || !sellAllowed} className={mode === "sell" ? "active sell" : ""} aria-pressed={mode === "sell"} onClick={() => { setMode("sell"); setAmount(""); }}>Sell</button>
      </div>

      <label className="pump-amount-field">
        <span><span>{mode === "buy" ? "Maximum spend" : "You pay"}</span><button type="button" disabled={pending} onClick={() => setAmount(formatUnits(sourceBalance, 18))}>Max {displayAmount(sourceBalance)}</button></span>
        <span><input inputMode="decimal" disabled={pending} value={amount} onChange={(event) => setAmount(event.target.value)} placeholder="0.0" /><strong>{mode === "buy" ? "NUSD" : market.symbol}</strong></span>
      </label>

      <div className="pump-quote-arrow" aria-hidden="true">&darr;</div>

      <div className="pump-amount-field pump-amount-output">
        <span><span>You receive</span><small>{quotePending ? "Quoting" : "Estimated"}</small></span>
        <span><strong>{displayAmount(quoteOutput)}</strong><b>{mode === "buy" ? market.symbol : "NUSD"}</b></span>
      </div>

      <div className="pump-trade-details">
        {mode === "buy" ? <div><span>Actual spend</span><strong>${displayAmount(actualInput)}</strong></div> : null}
        <div><span>Protocol fee</span><strong>${displayAmount(quoteFee)} (0.1%)</strong></div>
        <div><span>Slippage</span><span className="pump-inline-options">{[50n, 100n, 200n].map((value) => <button key={value.toString()} type="button" disabled={pending} className={slippageBps === value ? "active" : ""} aria-pressed={slippageBps === value} onClick={() => setSlippageBps(value)}>{Number(value) / 100}%</button>)}</span></div>
        {mode === "buy" && buyQuote.data?.[4] ? <p>This buy reaches the $6,000 READY target.</p> : null}
      </div>

      {quoteError ? <p className="pump-inline-error">Quote unavailable. <button type="button" onClick={() => void activeQuote.refetch()}>Retry</button></p> : null}

      {market.status === "READY" && !exitOpen ? <p className="pump-form-hint">Trading is frozen at the $6,000 target so this market can graduate. Sells reopen after the exit delay{exitOpensAt !== undefined ? ` (${formatRemaining(exitOpensAt)})` : ""} if graduation never happens.</p> : null}
      {market.status === "READY" && exitOpen && graduationPossible.data !== false ? <p className="pump-form-hint">Graduation did not happen in time. Selling reopens the bonding curve.</p> : null}
      {market.status === "READY" && exitOpen && graduationPossible.data === false ? <p className="pump-form-hint">Graduation is not available yet, so selling remains open and reopens the bonding curve.</p> : null}
      {market.status === "TRADING" && pumpPaused.data === true ? <p className="pump-form-hint">The launchpad is paused. Buys and new tokens are blocked; selling remains available.</p> : null}
      <button type="button" className="pump-button pump-button-primary pump-button-large pump-button-full" disabled={pending || !configured || quotePending || Boolean(quoteError) || !tradeAllowed} onClick={() => void submit()}>{buttonLabel}</button>
      {!configured ? <p className="pump-form-hint">Trading activates after deployment addresses are configured.</p> : null}
    </aside>
  );
}
