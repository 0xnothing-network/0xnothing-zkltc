"use client";

import type { Abi, Address } from "viem";
import { useAccount, useBalance, useReadContracts } from "wagmi";
import { TransactionStatus } from "@fi/components/UiStates";
import { useToast } from "@fi/components/Toast";
import { deployment, explorerAddressUrl } from "@fi/config/deployment";
import { erc20Abi } from "@fi/lib/abis/erc20";
import { lendingRevenueAbi, pumpRevenueAbi, rewardStakingAbi, routerRevenueAbi } from "@fi/lib/abis/tokenomics";
import { formatAmount } from "@fi/lib/format";
import { useProtocolTransaction } from "@fi/lib/hooks/useProtocolTransaction";

const REVENUE_POLL_MS = 15_000;

type Source = {
  key: string;
  label: string;
  detail: string;
  asset: "NUSD" | "WzkLTC";
  pending: bigint | undefined;
  call?: { address: Address; abi: Abi; functionName: string; args?: readonly unknown[] };
};

/**
 * Where protocol revenue sits and where it goes. Every source is pushed by a permissionless call:
 * NUSD is split 50/50 between the 0xPoints reward pool and the treasury, WzkLTC goes to the treasury.
 */
export function RevenuePanel() {
  const { isConnected } = useAccount();
  const toast = useToast();
  const tx = useProtocolTransaction();
  const { pump, dexRouter, lendingPool, nusd, wzkltc, treasury, rewardStaking, feeSplitter } = deployment.contracts;

  const reads = useReadContracts({
    contracts: pump && dexRouter && lendingPool && nusd && wzkltc && treasury && rewardStaking ? [
      { address: pump, abi: pumpRevenueAbi, functionName: "accruedProtocolFeesNusd" },
      { address: dexRouter, abi: routerRevenueAbi, functionName: "accruedRouterFees", args: [nusd] },
      { address: dexRouter, abi: routerRevenueAbi, functionName: "accruedRouterFees", args: [wzkltc] },
      { address: lendingPool, abi: lendingRevenueAbi, functionName: "protocolInterestNusd" },
      { address: rewardStaking, abi: rewardStakingAbi, functionName: "availableRewards" },
      { address: nusd, abi: erc20Abi, functionName: "balanceOf", args: [treasury] },
      { address: wzkltc, abi: erc20Abi, functionName: "balanceOf", args: [treasury] },
    ] as const : [],
    query: { enabled: Boolean(pump && dexRouter && lendingPool && treasury), refetchInterval: REVENUE_POLL_MS, refetchIntervalInBackground: false },
  });
  const nativeTreasury = useBalance({ address: treasury, query: { enabled: Boolean(treasury), refetchInterval: REVENUE_POLL_MS } });
  const value = (index: number) => reads.data?.[index]?.result as bigint | undefined;

  if (!pump || !dexRouter || !lendingPool || !nusd || !wzkltc || !treasury || !rewardStaking || !feeSplitter) return null;

  const sources: Source[] = [
    { key: "pump", label: "0xPump fees", detail: "Creation and trading fees", asset: "NUSD", pending: value(0), call: { address: pump, abi: pumpRevenueAbi, functionName: "distributeFees" } },
    { key: "router-nusd", label: "0xFi swap fees", detail: "Paid in NUSD", asset: "NUSD", pending: value(1), call: { address: dexRouter, abi: routerRevenueAbi, functionName: "distributeFees", args: [nusd] } },
    { key: "router-wzkltc", label: "0xFi swap fees", detail: "Paid in zkLTC · 100% treasury", asset: "WzkLTC", pending: value(2), call: { address: dexRouter, abi: routerRevenueAbi, functionName: "distributeFees", args: [wzkltc] } },
    { key: "lending", label: "Lending spread", detail: "Protocol share of borrow interest", asset: "NUSD", pending: value(3), call: { address: lendingPool, abi: lendingRevenueAbi, functionName: "sweepProtocolInterest" } },
  ];

  async function send(source: Source) {
    if (!source.call || !source.pending) return;
    const hash = await tx.execute({ call: source.call });
    if (hash) {
      toast.show("Revenue sent", `${formatAmount(source.pending)} ${source.asset} left ${source.label}.`, "success");
      void reads.refetch();
      void nativeTreasury.refetch();
    }
  }

  const pendingNusd = sources.reduce((sum, source) => (source.asset === "NUSD" ? sum + (source.pending ?? 0n) : sum), 0n);
  const treasuryZkltc = value(6) === undefined || nativeTreasury.data === undefined ? undefined : value(6)! + nativeTreasury.data.value;

  return (
    <details className="fi-panel fi-revenue-panel">
      <summary>
        <span className="fi-revenue-title">Revenue and treasury</span>
        <span className="fi-revenue-summary">
          <span>Waiting <strong>{formatAmount(pendingNusd, 18, 4)}</strong> NUSD</span>
          <span>Pool <strong>{formatAmount(value(4), 18, 2)}</strong> NUSD</span>
          <span>Treasury <strong>{formatAmount(value(5), 18, 2)}</strong> NUSD · <strong>{formatAmount(treasuryZkltc, 18, 4)}</strong> zkLTC</span>
        </span>
      </summary>
      <p className="fi-revenue-copy">
        NUSD fees split 50% to the reward pool and 50% to the treasury; zkLTC swap fees go to the treasury. Anyone can
        send pending fees. Only the owner spends the{" "}
        <a href={explorerAddressUrl(treasury)} target="_blank" rel="noopener noreferrer">treasury</a> (
        <a href={explorerAddressUrl(feeSplitter)} target="_blank" rel="noopener noreferrer">splitter</a>).
      </p>
      <ul className="fi-revenue-list">
        {sources.map((source) => (
          <li key={source.key}>
            <span><strong>{source.label}</strong><small>{source.detail}</small></span>
            <span className="fi-revenue-amount">{formatAmount(source.pending, 18, 6)} {source.asset}</span>
            <button type="button" className="fi-button fi-button-muted" disabled={!isConnected || !source.pending || tx.pending} onClick={() => void send(source)}>
              Send
            </button>
          </li>
        ))}
      </ul>
      <TransactionStatus phase={tx.phase} message={tx.message} hash={tx.hash} step={tx.step} totalSteps={tx.totalSteps} />
    </details>
  );
}
