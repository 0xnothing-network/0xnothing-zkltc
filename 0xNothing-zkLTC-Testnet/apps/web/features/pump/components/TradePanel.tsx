"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { formatUnits, parseUnits } from "viem";
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
import { LITVM_ADD_CHAIN_PARAMETER } from "@/config/network";
import { curvePriceImpact, impactTone, type ImpactTone } from "@/lib/ui/priceImpact";

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
  const [nowSec, setNowSec] = useState(() => Math.floor(Date.now() / 1000));
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
  const pumpSellsPaused = useReadContract({
    chainId: PUMP_CHAIN_ID,
    address: PUMP_FACTORY_ADDRESS,
    abi: zeroXPumpAbi,
    functionName: "sellsPaused",
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
    && readyAt.data !== undefined && readyExitDelay.data !== undefined && !readyAt.isError && !readyExitDelay.isError
    ? readyAt.data + readyExitDelay.data
    : undefined;
  const exitOpen = market.status === "READY" && readySellsAreOpen(graduationPossible.data, readyAt.data, readyExitDelay.data, nowSec);
  const buyAllowed = market.status === "TRADING" && pumpPaused.data === false;
  const sellAllowed = (market.status === "TRADING" || exitOpen) && pumpSellsPaused.data === false;

  useEffect(() => {
    if (exitOpensAt === undefined) return;
    const tick = () => setNowSec(Math.floor(Date.now() / 1000));
    tick();
    if (BigInt(Math.floor(Date.now() / 1000)) >= exitOpensAt) return;
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [exitOpensAt]);
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
      switchChain({ chainId: PUMP_CHAIN_ID, addEthereumChainParameter: LITVM_ADD_CHAIN_PARAMETER });
      return;
    }
    if (!publicClient) {
      toast.error("RPC unavailable", "Refresh the page and try again.");
      return;
    }
    if (!tradeAllowed) {
      toast.info(
        market.status === "GRADUATED" ? "Curve closed"
          : pumpSellsPaused.data !== false && mode === "sell" ? "Sells paused"
          : market.status === "READY" ? "$6,000 market cap reached"
          : "Buys paused",
        market.status === "GRADUATED"
          ? "Trading on this bonding curve has ended."
          : pumpSellsPaused.data !== false && mode === "sell"
            ? "Emergency sell pause is active. Sells reopen automatically within 24 hours."
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
        // Exact approval (spec §6.3): the curve pulls at most `amountWei`
        // (buy max spend / sell amount), so nothing is left approved beyond it.
        const approvalAmount = amountWei;
        const hash = mode === "buy"
          ? await writeContractAsync({ account: address, chainId: PUMP_CHAIN_ID, address: PUMP_NUSD_ADDRESS, abi: nusdAbi, functionName: "approve", args: [PUMP_FACTORY_ADDRESS, approvalAmount] })
          : await writeContractAsync({ account: address, chainId: PUMP_CHAIN_ID, address: market.tokenAddress, abi: pumpTokenAbi, functionName: "approve", args: [PUMP_FACTORY_ADDRESS, approvalAmount] });
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
    : pumpSellsPaused.data !== false && mode === "sell" ? "Sells paused"
    : market.status === "READY" && !exitOpen ? "Awaiting graduation"
    : market.status === "READY" && mode === "buy" ? "Buy paused at READY"
    : pumpPaused.isLoading && mode === "buy" ? "Checking pause"
    : pumpPaused.data !== false && mode === "buy" ? "Buys paused"
    : pending ? "Confirming transaction"
    : needsApproval ? `Approve ${mode === "buy" ? "NUSD" : market.symbol} & ${mode === "buy" ? "buy" : "sell"}`
    : mode === "buy" ? `Buy ${market.symbol}` : `Sell ${market.symbol}`;

  const impact = curvePriceImpact(mode, Number(market.priceNusd), mode === "buy" ? actualInput : amountWei, quoteOutput);
  const impactLevel = impact === null ? null : impactTone(impact);
  const presets = mode === "buy"
    ? BUY_PRESETS.map((value) => ({ label: `$${value}`, value: String(value) }))
    : SELL_PRESETS.map((pct) => ({ label: `${pct}%`, value: formatUnits((sourceBalance * BigInt(pct)) / 100n, 18) }));

  return (
    <section className="pump-trade-card ui rounded-ui-lg border border-line bg-surface-1 p-4 font-ui text-fg shadow-e1 sm:p-5" aria-label="Trade">
      <div className="grid grid-cols-2 gap-1 rounded-ui-md border border-line bg-surface-2 p-1" role="group" aria-label="Trade side">
        <button type="button" disabled={pending || !buyAllowed} className={`h-9 rounded-ui-sm text-sm font-medium focus-ring disabled:cursor-not-allowed disabled:text-fg-disabled ${mode === "buy" ? "bg-positive text-[#04130B]" : "text-fg-2 hover:text-fg"}`} aria-pressed={mode === "buy"} onClick={() => { setMode("buy"); setAmount(""); }}>Buy</button>
        <button type="button" disabled={pending || !sellAllowed} className={`h-9 rounded-ui-sm text-sm font-medium focus-ring disabled:cursor-not-allowed disabled:text-fg-disabled ${mode === "sell" ? "bg-negative text-[#1F0308]" : "text-fg-2 hover:text-fg"}`} aria-pressed={mode === "sell"} onClick={() => { setMode("sell"); setAmount(""); }}>Sell</button>
      </div>

      <div className="mt-3 rounded-ui-lg border border-line bg-surface-2 p-3.5 focus-within:border-accent">
        <div className="flex items-center justify-between gap-2 text-xs">
          <label htmlFor="pump-trade-amount" className="font-medium text-fg-3">{mode === "buy" ? "You pay (max)" : "You sell"}</label>
          <span className="flex items-center gap-2 text-fg-3">
            <span className="font-num tnum">Balance {displayAmount(sourceBalance)}</span>
            <button type="button" disabled={pending} className="h-6 rounded-ui-xs bg-accent-soft px-1.5 text-[11px] font-semibold text-accent-text focus-ring disabled:opacity-50" onClick={() => setAmount(formatUnits(sourceBalance, 18))}>MAX</button>
          </span>
        </div>
        <div className="mt-1.5 flex items-center gap-3">
          <input id="pump-trade-amount" inputMode="decimal" autoComplete="off" disabled={pending} value={amount} onChange={(event) => setAmount(event.target.value)} placeholder="0.0" className="min-w-0 flex-1 bg-transparent font-num tnum text-[28px] leading-none text-fg outline-none placeholder:text-fg-disabled" />
          <span className="shrink-0 rounded-full border border-line bg-surface-3 px-3 py-1.5 text-sm font-medium">{mode === "buy" ? "NUSD" : market.symbol}</span>
        </div>
        <div className="mt-3 flex flex-wrap gap-1.5">
          {presets.map((preset) => (
            <button key={preset.label} type="button" disabled={pending} className="h-7 flex-1 rounded-ui-sm border border-line bg-surface-1 px-2 font-num text-xs text-fg-2 hover:border-line-strong hover:text-fg focus-ring disabled:opacity-50" onClick={() => setAmount(preset.value)}>{preset.label}</button>
          ))}
        </div>
      </div>

      <div className="mt-2 rounded-ui-lg border border-line bg-surface-2 p-3.5" aria-live="polite">
        <div className="flex items-center justify-between text-xs text-fg-3"><span className="font-medium">You receive (est.)</span><span>{quotePending ? "Quoting…" : "Estimated"}</span></div>
        <div className="mt-1.5 flex items-center gap-3">
          <strong className={`min-w-0 flex-1 truncate font-num tnum text-[28px] font-normal leading-none ${quotePending ? "text-fg-3" : "text-fg"}`}>{displayAmount(quoteOutput)}</strong>
          <span className="shrink-0 rounded-full border border-line bg-surface-3 px-3 py-1.5 text-sm font-medium">{mode === "buy" ? market.symbol : "NUSD"}</span>
        </div>
      </div>

      <dl className="mt-3 grid gap-0.5 text-[13px]">
        <div className="flex justify-between py-1"><dt className="text-fg-3">Price impact</dt><dd className={`font-num tnum ${IMPACT_CLASS[impactLevel ?? "none"]}`}>{impact === null ? "—" : `${impact.toFixed(2)}%`}</dd></div>
        {mode === "buy" ? <div className="flex justify-between py-1"><dt className="text-fg-3">Actual spend</dt><dd className="font-num tnum">${displayAmount(actualInput)}</dd></div> : null}
        <div className="flex justify-between py-1"><dt className="text-fg-3">Protocol fee (0.1%)</dt><dd className="font-num tnum">${displayAmount(quoteFee)}</dd></div>
        <div className="flex items-center justify-between py-1"><dt className="text-fg-3">Slippage</dt><dd className="flex gap-1">{[50n, 100n, 200n].map((value) => <button key={value.toString()} type="button" disabled={pending} className={`h-7 rounded-ui-sm px-2 font-num text-xs focus-ring ${slippageBps === value ? "bg-fg text-bg" : "bg-surface-2 text-fg-2 hover:text-fg"}`} aria-pressed={slippageBps === value} onClick={() => setSlippageBps(value)}>{Number(value) / 100}%</button>)}</dd></div>
      </dl>
      {mode === "buy" && buyQuote.data?.[4] ? <p className="mt-2 rounded-ui-md bg-warning-bg px-3 py-2 text-xs text-warning">This buy reaches the $6,000 READY target. Any amount past it is refunded.</p> : null}
      {impactLevel === "severe" ? <p role="alert" className="mt-2 rounded-ui-md bg-negative-bg px-3 py-2 text-xs text-negative">High price impact: you'd receive about {impact?.toFixed(1)}% less than the spot price. Try a smaller amount.</p> : null}
      {needsApproval && amountWei > 0n ? <p className="mt-2 rounded-ui-md bg-surface-2 px-3 py-2 text-xs text-fg-2">First, approve exactly this amount of {mode === "buy" ? "NUSD" : market.symbol}. You'll sign <strong className="text-fg">2 transactions</strong>.</p> : null}

      {quoteError ? <p className="mt-2 text-xs text-negative">Quote unavailable. <button type="button" className="underline focus-ring" onClick={() => void activeQuote.refetch()}>Retry</button></p> : null}

      {market.status === "READY" && !exitOpen ? <p className="pump-trade-hint mt-2 text-xs text-fg-3">Trading is frozen at the $6,000 target so this market can graduate. Sells reopen after the exit delay{exitOpensAt !== undefined ? ` (${formatRemaining(exitOpensAt, nowSec)})` : ""} if graduation never happens.</p> : null}
      {market.status === "READY" && exitOpen && graduationPossible.data !== false ? <p className="pump-trade-hint mt-2 text-xs text-fg-3">Graduation did not happen in time. Selling reopens the bonding curve.</p> : null}
      {market.status === "READY" && exitOpen && graduationPossible.data === false ? <p className="pump-trade-hint mt-2 text-xs text-fg-3">Graduation is not available yet, so selling remains open and reopens the bonding curve.</p> : null}
      {market.status === "TRADING" && pumpPaused.data === true ? <p className="pump-trade-hint mt-2 text-xs text-fg-3">The launchpad is paused. Buys and new tokens are blocked; selling remains available.</p> : null}
      {pumpSellsPaused.data === true ? <p className="pump-trade-hint mt-2 text-xs text-fg-3">Emergency sell pause is active. Sells reopen automatically within 24 hours.</p> : null}
      <button type="button" className={`pump-button-large mt-4 flex h-[52px] min-h-[52px] w-full items-center justify-center rounded-ui-md text-base font-medium focus-ring disabled:cursor-not-allowed disabled:bg-surface-2 disabled:text-fg-disabled ${mode === "buy" ? "bg-positive text-[#04130B] hover:brightness-110" : "bg-negative text-[#1F0308] hover:brightness-110"}`} disabled={pending || !configured || quotePending || Boolean(quoteError) || !tradeAllowed} aria-busy={pending || undefined} onClick={() => void submit()}>{buttonLabel}</button>
      {!configured ? <p className="pump-trade-hint mt-2 text-xs text-fg-3">Trading activates after deployment addresses are configured.</p> : null}
    </section>
  );
}

const BUY_PRESETS = [10, 50, 100, 500] as const;
const SELL_PRESETS = [25, 50, 75, 100] as const;
const IMPACT_CLASS: Record<ImpactTone | "none", string> = {
  none: "text-fg-3",
  low: "text-positive",
  medium: "text-warning",
  high: "text-hf-risk",
  severe: "text-negative",
};
