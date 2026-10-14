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
    { key: "router-nusd", label: "0xFi swap fees", detail: "Router fees paid in NUSD", asset: "NUSD", pending: value(1), call: { address: dexRouter, abi: routerRevenueAbi, functionName: "distributeFees", args: [nusd] } },
    { key: "router-wzkltc", label: "0xFi swap fees", detail: "Router fees paid in zkLTC, 100% treasury", asset: "WzkLTC", pending: value(2), call: { address: dexRouter, abi: routerRevenueAbi, functionName: "distributeFees", args: [wzkltc] } },
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

  return (
    <section className="fi-panel fi-revenue-panel" aria-labelledby="revenue-title">
      <header className="fi-points-card-heading">
        <div><span className="fi-label">Open to anyone</span><h2 id="revenue-title">Revenue and treasury</h2></div>
      </header>
      <p className="fi-revenue-copy">
        NUSD revenue is split 50% to the 0xPoints reward pool and 50% to the treasury; zkLTC swap fees go to the
        treasury. Nothing moves until someone sends it, and anyone may. The treasury is spent by the owner wallet alone.
      </p>
      <div className="fi-revenue-grid">
        <table className="fi-revenue-table">
          <thead><tr><th scope="col">Source</th><th scope="col">Waiting</th><th scope="col"><span className="sr-only">Action</span></th></tr></thead>
          <tbody>
            {sources.map((source) => (
              <tr key={source.key}>
                <th scope="row"><strong>{source.label}</strong><small>{source.detail}</small></th>
                <td>{formatAmount(source.pending, 18, 6)} {source.asset}</td>
                <td>
                  <button type="button" className="fi-button fi-button-muted" disabled={!isConnected || !source.pending || tx.pending} onClick={() => void send(source)}>
                    Send
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <dl className="fi-points-metrics fi-revenue-balances" aria-label="Reward pool and treasury balances">
          <div><dt>Reward pool (unallocated)</dt><dd>{formatAmount(value(4), 18, 2)} <small>NUSD</small></dd></div>
          <div><dt>Treasury NUSD</dt><dd>{formatAmount(value(5), 18, 2)} <small>NUSD</small></dd></div>
          <div><dt>Treasury zkLTC</dt><dd>{formatAmount(value(6) === undefined || nativeTreasury.data === undefined ? undefined : value(6)! + nativeTreasury.data.value, 18, 4)} <small>zkLTC</small></dd></div>
          <div><dt>Contracts</dt><dd><a href={explorerAddressUrl(treasury)} target="_blank" rel="noopener noreferrer">Treasury</a> · <a href={explorerAddressUrl(feeSplitter)} target="_blank" rel="noopener noreferrer">Splitter</a></dd></div>
        </dl>
      </div>
      <TransactionStatus phase={tx.phase} message={tx.message} hash={tx.hash} step={tx.step} totalSteps={tx.totalSteps} />
    </section>
  );
}
