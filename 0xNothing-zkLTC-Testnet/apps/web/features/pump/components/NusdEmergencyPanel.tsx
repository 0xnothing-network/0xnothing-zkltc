"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { formatUnits, parseAbi, parseUnits } from "viem";
import { useAccount, useConfig, usePublicClient, useReadContract, useReadContracts, useSwitchChain, useWriteContract } from "wagmi";
import { useToast } from "@/components/Toast";
import { NUSD_CONFIGURED, PUMP_CHAIN_ID, PUMP_NUSD_ADDRESS } from "@/features/pump/config";
import { releaseAction, tryAcquireAction } from "@/lib/actionLock";
import { createPumpWalletGuard } from "@/features/pump/walletSession";
import { waitForProtocolReceipt } from "@/lib/transactionReceipt";

const nusdEmergencyAbi = parseAbi([
  "function balanceOf(address account) view returns (uint256)",
  "function totalSupply() view returns (uint256)",
  "function totalCollateralWei() view returns (uint256)",
  "function oracle() view returns (address)",
  "function oracleFailureReportedAt() view returns (uint256)",
  "function ORACLE_FAILURE_GRACE() view returns (uint256)",
  "function reportOracleFailure()",
  "function clearOracleFailure()",
  "function emergencyRedeem(uint256 amountNusd, uint256 minCollateralOutWei, address recipient) returns (uint256)",
]);
const oracleFreshAbi = parseAbi(["function isFresh() view returns (bool)"]);
const POLL_MS = 30_000;

function wad(value: bigint | undefined, digits = 4): string {
  if (value === undefined) return "--";
  return Number(formatUnits(value, 18)).toLocaleString("en-US", { maximumFractionDigits: digits });
}

function parseNusd(value: string): bigint {
  try {
    return value.trim() ? parseUnits(value.trim(), 18) : 0n;
  } catch {
    return 0n;
  }
}

/**
 * NUSD price-free exit. If the DIA oracle stays unusable for 7 days after anyone reports it,
 * holders can burn NUSD for their pro-rata share of the zkLTC reserve, even while redeem is paused.
 */
export function NusdEmergencyPanel() {
  const toast = useToast();
  const { address, isConnected, chainId } = useAccount();
  const walletConfig = useConfig();
  const publicClient = usePublicClient({ chainId: PUMP_CHAIN_ID });
  const { switchChain } = useSwitchChain();
  const { writeContractAsync } = useWriteContract();
  const lockRef = useRef(false);
  const [amountText, setAmountText] = useState("");
  const [busy, setBusy] = useState(false);
  const [nowSeconds, setNowSeconds] = useState<number>();

  useEffect(() => {
    const tick = () => setNowSeconds(Math.floor(Date.now() / 1000));
    tick();
    const timer = window.setInterval(tick, 30_000);
    return () => window.clearInterval(timer);
  }, []);

  const reads = useReadContracts({
    contracts: NUSD_CONFIGURED ? [
      { address: PUMP_NUSD_ADDRESS, abi: nusdEmergencyAbi, functionName: "oracleFailureReportedAt", chainId: PUMP_CHAIN_ID },
      { address: PUMP_NUSD_ADDRESS, abi: nusdEmergencyAbi, functionName: "ORACLE_FAILURE_GRACE", chainId: PUMP_CHAIN_ID },
      { address: PUMP_NUSD_ADDRESS, abi: nusdEmergencyAbi, functionName: "totalSupply", chainId: PUMP_CHAIN_ID },
      { address: PUMP_NUSD_ADDRESS, abi: nusdEmergencyAbi, functionName: "totalCollateralWei", chainId: PUMP_CHAIN_ID },
      { address: PUMP_NUSD_ADDRESS, abi: nusdEmergencyAbi, functionName: "oracle", chainId: PUMP_CHAIN_ID },
    ] as const : [],
    query: { enabled: NUSD_CONFIGURED, refetchInterval: POLL_MS },
  });
  const reportedAt = reads.data?.[0]?.result as bigint | undefined;
  const grace = reads.data?.[1]?.result as bigint | undefined;
  const supply = reads.data?.[2]?.result as bigint | undefined;
  const collateral = reads.data?.[3]?.result as bigint | undefined;
  const oracle = reads.data?.[4]?.result as `0x${string}` | undefined;
  const balanceRead = useReadContract({
    address: PUMP_NUSD_ADDRESS,
    abi: nusdEmergencyAbi,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    chainId: PUMP_CHAIN_ID,
    query: { enabled: Boolean(NUSD_CONFIGURED && address), refetchInterval: POLL_MS },
  });
  const balance = balanceRead.data;

  const freshness = useReadContracts({
    contracts: oracle ? [{ address: oracle, abi: oracleFreshAbi, functionName: "isFresh", chainId: PUMP_CHAIN_ID }] : [],
    query: { enabled: Boolean(oracle), refetchInterval: POLL_MS },
  });
  const oracleFresh = freshness.data?.[0]?.result as boolean | undefined;

  const amount = useMemo(() => parseNusd(amountText), [amountText]);
  const quote = supply && collateral !== undefined && amount > 0n ? (amount * collateral) / supply : undefined;
  const minOut = quote === undefined ? 0n : (quote * 995n) / 1000n;
  const reported = reportedAt !== undefined && reportedAt > 0n;
  const opensAt = reported && grace !== undefined ? reportedAt + grace : undefined;
  const exitOpen = Boolean(reported && opensAt !== undefined && nowSeconds !== undefined && BigInt(nowSeconds) >= opensAt && oracleFresh === false);
  const wrongChain = isConnected && chainId !== PUMP_CHAIN_ID;

  async function send(functionName: "reportOracleFailure" | "clearOracleFailure" | "emergencyRedeem", title: string, description: string) {
    if (!address || !publicClient) return;
    if (wrongChain) {
      switchChain({ chainId: PUMP_CHAIN_ID });
      return;
    }
    if (!tryAcquireAction(lockRef)) return;
    setBusy(true);
    try {
      const assertWalletUnchanged = createPumpWalletGuard(walletConfig, address);
      const target = { account: address, address: PUMP_NUSD_ADDRESS, abi: nusdEmergencyAbi } as const;
      assertWalletUnchanged();
      let hash: `0x${string}`;
      if (functionName === "emergencyRedeem") {
        const args = [amount, minOut, address] as const;
        await publicClient.simulateContract({ ...target, functionName, args });
        assertWalletUnchanged();
        hash = await writeContractAsync({ ...target, chainId: PUMP_CHAIN_ID, functionName, args });
      } else {
        await publicClient.simulateContract({ ...target, functionName });
        assertWalletUnchanged();
        hash = await writeContractAsync({ ...target, chainId: PUMP_CHAIN_ID, functionName });
      }
      await waitForProtocolReceipt(publicClient, hash);
      toast.show({ title, description, kind: "success" });
      setAmountText("");
      void reads.refetch();
      void balanceRead.refetch();
      void freshness.refetch();
    } catch (error) {
      toast.handleError(error, `${title} failed`);
    } finally {
      releaseAction(lockRef);
      setBusy(false);
    }
  }

  if (!NUSD_CONFIGURED) return null;

  let status = "Oracle healthy: mint and redeem use the DIA price.";
  if (oracleFresh === false && !reported) status = "DIA price is unavailable. Anyone can start the 7-day failure clock.";
  else if (reported && !exitOpen && oracleFresh === false) status = `Failure reported. The price-free exit opens ${opensAt ? new Date(Number(opensAt) * 1000).toUTCString() : "after 7 days"}.`;
  else if (reported && oracleFresh) status = "The oracle recovered. Anyone can clear the failure report.";
  else if (exitOpen) status = "Emergency exit open: burn NUSD for your pro-rata share of the zkLTC reserve.";

  return (
    <section className="pump-panel pump-vault pump-nusd-emergency" aria-labelledby="nusd-emergency-title">
      <div className="pump-panel-heading pump-vault-heading">
        <div><span className="pump-eyebrow">If the oracle stops</span><h2 id="nusd-emergency-title">Emergency exit</h2></div>
        <span className="pump-vault-oracle-status" data-state={exitOpen ? "error" : oracleFresh === false ? "loading" : "live"}>
          {exitOpen ? "EXIT OPEN" : reported ? "REPORTED" : oracleFresh === false ? "STALE" : "STANDBY"}
        </span>
      </div>
      <p className="pump-vault-alert">{status} No admin can block this path.</p>
      {oracleFresh === false && !reported ? (
        <button type="button" className="pump-button pump-button-large" disabled={!isConnected || busy} onClick={() => void send("reportOracleFailure", "Failure reported", "The 7-day clock has started.")}>Report oracle failure</button>
      ) : null}
      {reported && oracleFresh ? (
        <button type="button" className="pump-button pump-button-large" disabled={!isConnected || busy} onClick={() => void send("clearOracleFailure", "Report cleared", "The oracle is pricing again.")}>Clear failure report</button>
      ) : null}
      {exitOpen ? (
        <div className="pump-vault-workspace">
          <div className="pump-vault-form">
            <div className="pump-field pump-vault-step">
              <div className="pump-vault-field-head"><label htmlFor="nusd-emergency-input">NUSD to burn</label><button type="button" disabled={!balance} onClick={() => setAmountText(formatUnits(balance ?? 0n, 18))}>MAX {wad(balance, 2)}</button></div>
              <div className="pump-vault-token-field"><input id="nusd-emergency-input" inputMode="decimal" value={amountText} onChange={(event) => setAmountText(event.target.value)} placeholder="0.0" /><strong>NUSD</strong></div>
            </div>
            <button type="button" className="pump-button pump-button-primary pump-button-large" disabled={!isConnected || busy || amount === 0n || (balance !== undefined && amount > balance)} onClick={() => void send("emergencyRedeem", "NUSD redeemed", "Your share of the zkLTC reserve was sent to your wallet.")}>
              {wrongChain ? "Switch to LitVM" : busy ? "Confirming" : "Exit at reserve share"}
            </button>
          </div>
          <aside className="pump-vault-preview" aria-live="polite">
            <span className="pump-eyebrow">You receive</span>
            <strong className="pump-vault-preview-amount">{wad(quote, 6)}<small>zkLTC</small></strong>
            <dl><div><dt>Rule</dt><dd>NUSD × reserve ÷ supply</dd></div><div><dt>Minimum</dt><dd>{wad(minOut, 6)} zkLTC</dd></div></dl>
          </aside>
        </div>
      ) : null}
    </section>
  );
}
