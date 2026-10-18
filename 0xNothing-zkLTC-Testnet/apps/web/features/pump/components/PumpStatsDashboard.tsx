"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import {
  useAccount,
  useConfig,
  useReadContract,
  useSwitchChain,
  useWriteContract,
} from "wagmi";
import { zeroXPumpAbi } from "@/features/pump/abis";
import {
  PUMP_CHAIN_ID,
  PUMP_CONFIGURED,
  PUMP_FACTORY_ADDRESS,
} from "@/features/pump/config";
import {
  formatRelativeTime,
  formatStatus,
  formatWad,
  shortAddress,
} from "@/features/pump/format";
import { usePumpMarkets, usePumpStats } from "@/features/pump/hooks/usePumpData";
import { PumpConfigNotice, PumpErrorState } from "@/features/pump/components/PumpStates";
import { useToast } from "@/components/Toast";
import { getTransactionExplorerUrl, publicClient } from "@/lib/contract";
import { releaseAction, tryAcquireAction } from "@/lib/actionLock";
import { createPumpWalletGuard } from "@/features/pump/walletSession";
import { waitForProtocolReceipt } from "@/lib/transactionReceipt";

function usd(value: string, fractionDigits = 2): string {
  return `$${formatWad(value, fractionDigits)}`;
}

export function PumpStatsDashboard() {
  const statsQuery = usePumpStats();
  const marketsQuery = usePumpMarkets({ limit: 5, sort: "VOLUME" });
  const { address } = useAccount();
  const payload = statsQuery.data;
  const stats = payload?.stats;
  const hasIndexedTotals = payload?.source === "subgraph";
  const updatedLabel = payload?.updatedAt
    ? formatRelativeTime(payload.updatedAt)
    : payload?.source === "rpc"
      ? "Live"
      : "Waiting for data";

  return (
    <main className="pump-page pump-stats-page">
      <section className="pump-page-heading pump-stats-heading">
        <div>
          <span className="pump-eyebrow">Protocol analytics</span>
          <h1>0xPump stats</h1>
        </div>
      </section>

      {payload?.configured === false ? <PumpConfigNotice /> : null}
      {payload?.warning ? <p className="pump-source-note">{payload.warning}</p> : null}
      {marketsQuery.data?.warning && marketsQuery.data.warning !== payload?.warning ? (
        <p className="pump-source-note">{marketsQuery.data.warning}</p>
      ) : null}

      {statsQuery.isLoading ? (
        <StatsSkeleton />
      ) : statsQuery.error || !stats ? (
        <PumpErrorState
          message={statsQuery.error?.message ?? "Protocol statistics are unavailable."}
          onRetry={() => void statsQuery.refetch()}
        />
      ) : (
        <>
          <div className="pump-stats-source" aria-live="polite">
            <span>Updated {updatedLabel}</span>
          </div>

          <section className="pump-stats-primary" aria-label="Protocol totals">
            <div className="pump-stats-primary-featured">
              <span>Total volume</span>
              <strong>{usd(stats.volumeNusd)}</strong>
              <small>Curve volume across every buy and sell</small>
            </div>
            <div>
              <span>Protocol revenue</span>
              <strong>{hasIndexedTotals ? usd(stats.feesNusd, 4) : "--"}</strong>
              <small>Creation and trading fees earned</small>
            </div>
            <div>
              <span>Total trades</span>
              <strong>{hasIndexedTotals ? stats.tradeCount.toLocaleString("en-US") : "--"}</strong>
              <small>{hasIndexedTotals ? `${stats.buyCount} buys, ${stats.sellCount} sells` : "Requires the protocol index"}</small>
            </div>
            <div>
              <span>Markets launched</span>
              <strong>{stats.marketCount.toLocaleString("en-US")}</strong>
              <small>{stats.tradingCount} currently trading</small>
            </div>
          </section>

          <div className="pump-stats-detail-grid">
            <section className="pump-stats-section" aria-labelledby="pump-revenue-title">
              <div className="pump-stats-section-heading">
                <div>
                  <span className="pump-eyebrow">Revenue</span>
                  <h2 id="pump-revenue-title">Fee breakdown</h2>
                </div>
                <strong>{hasIndexedTotals ? usd(stats.feesNusd, 4) : "--"}</strong>
              </div>
              <dl className="pump-stats-list">
                <div>
                  <dt>Market creation fees</dt>
                  <dd>{hasIndexedTotals ? usd(stats.creationFeesNusd, 4) : "--"}</dd>
                </div>
                <div>
                  <dt>Trading fees</dt>
                  <dd>{hasIndexedTotals ? usd(stats.tradeFeesNusd, 4) : "--"}</dd>
                </div>
              </dl>
            </section>

            <section className="pump-stats-section" aria-labelledby="pump-market-state-title">
              <div className="pump-stats-section-heading">
                <div>
                  <span className="pump-eyebrow">Markets</span>
                  <h2 id="pump-market-state-title">Lifecycle</h2>
                </div>
              </div>
              <div className="pump-stats-lifecycle">
                <div><strong>{stats.tradingCount}</strong><span>Trading</span></div>
                <div><strong>{stats.readyCount}</strong><span>Ready</span></div>
                <div><strong>{stats.graduatedCount}</strong><span>Graduated</span></div>
              </div>
            </section>
          </div>

          <section className="pump-stats-section pump-stats-leaderboard" aria-labelledby="pump-top-markets-title">
            <div className="pump-stats-section-heading">
              <div>
                <span className="pump-eyebrow">Volume ranking</span>
                <h2 id="pump-top-markets-title">Top markets</h2>
              </div>
            </div>
            {marketsQuery.isLoading ? (
              <div className="pump-stats-market-skeleton" role="status" aria-label="Loading top markets" />
            ) : marketsQuery.error ? (
              <p className="pump-stats-inline-error">Top markets are temporarily unavailable.</p>
            ) : marketsQuery.markets.length ? (
              <div className="pump-stats-market-list">
                {marketsQuery.markets.map((market, index) => (
                  <Link href={`/0xPump/token/${market.tokenAddress}`} key={market.tokenAddress}>
                    <span className="pump-stats-rank">{String(index + 1).padStart(2, "0")}</span>
                    <span className="pump-stats-market-name">
                      <strong>{market.name}</strong>
                      <small>${market.symbol}</small>
                    </span>
                    <span className={`pump-status pump-status-${market.status.toLowerCase()}`}>{formatStatus(market.status)}</span>
                    <span className="pump-stats-market-trades">{market.tradeCount.toLocaleString("en-US")} trades</span>
                    <strong className="pump-stats-market-volume">{usd(market.volumeNusd)}</strong>
                  </Link>
                ))}
              </div>
            ) : (
              <p className="pump-empty-inline">No markets have been launched yet.</p>
            )}
          </section>
        </>
      )}

      {PUMP_CONFIGURED ? (
        <ProtocolFeePanel
          address={address}
          distributedFeesNusd={stats?.withdrawnFeesNusd}
          indexedTotalsAvailable={Boolean(stats && hasIndexedTotals)}
          onDistributed={() => void statsQuery.refetch()}
        />
      ) : null}
    </main>
  );
}

/**
 * Protocol fees do not belong to an admin. Anyone can send them to the fee splitter, which
 * splits them in the same call: 70% to stakers, 20% burned, 10% to the treasury.
 */
function ProtocolFeePanel({
  address,
  distributedFeesNusd,
  indexedTotalsAvailable,
  onDistributed,
}: {
  address?: `0x${string}`;
  distributedFeesNusd?: string;
  indexedTotalsAvailable: boolean;
  onDistributed: () => void;
}) {
  const toast = useToast();
  const { chainId } = useAccount();
  const walletConfig = useConfig();
  const { switchChainAsync, isPending: isSwitching } = useSwitchChain();
  const { writeContractAsync } = useWriteContract();
  const actionLockRef = useRef(false);
  const [isSending, setIsSending] = useState(false);
  const wrongChain = Boolean(address) && chainId !== PUMP_CHAIN_ID;
  const pendingQuery = useReadContract({
    address: PUMP_FACTORY_ADDRESS,
    abi: zeroXPumpAbi,
    functionName: "accruedProtocolFeesNusd",
    chainId: PUMP_CHAIN_ID,
  });
  const recipientQuery = useReadContract({
    address: PUMP_FACTORY_ADDRESS,
    abi: zeroXPumpAbi,
    functionName: "feeRecipient",
    chainId: PUMP_CHAIN_ID,
    query: { staleTime: Infinity },
  });
  const pending = pendingQuery.data ?? 0n;
  const actionPending = isSending || isSwitching;
  // Only the first read gates the button; the amount is re-simulated before the write.
  const feeReadPending = pendingQuery.isLoading;

  const handleDistribute = async () => {
    if (!address) return;
    if (wrongChain) {
      try {
        await switchChainAsync({ chainId: PUMP_CHAIN_ID });
      } catch (error) {
        toast.handleError(error, "Network switch failed");
      }
      return;
    }
    if (pendingQuery.error || pendingQuery.data === undefined) {
      await pendingQuery.refetch();
      return;
    }
    if (pending <= 0n || !tryAcquireAction(actionLockRef)) return;

    setIsSending(true);
    try {
      const assertWalletUnchanged = createPumpWalletGuard(walletConfig, address);
      assertWalletUnchanged();
      await publicClient.simulateContract({
        account: address,
        address: PUMP_FACTORY_ADDRESS,
        abi: zeroXPumpAbi,
        functionName: "distributeFees",
      });
      assertWalletUnchanged();
      const hash = await writeContractAsync({
        account: address,
        address: PUMP_FACTORY_ADDRESS,
        abi: zeroXPumpAbi,
        functionName: "distributeFees",
        chainId: PUMP_CHAIN_ID,
      });
      const receipt = await waitForProtocolReceipt(publicClient, hash);
      toast.show({
        title: "Fees distributed",
        description: `${formatWad(pending, 6)} NUSD went 70% to stakers, 20% burned and 10% to the treasury.`,
        kind: "success",
        href: getTransactionExplorerUrl(receipt.transactionHash),
        hrefLabel: "View transaction",
      });
      await pendingQuery.refetch();
      onDistributed();
    } catch (error) {
      toast.handleError(error, "Fee distribution failed");
    } finally {
      releaseAction(actionLockRef);
      setIsSending(false);
    }
  };

  let buttonLabel = "Nothing to distribute";
  if (!address) buttonLabel = "Connect a wallet to distribute";
  else if (actionPending) buttonLabel = isSwitching ? "Switching" : "Distributing";
  else if (wrongChain) buttonLabel = "Switch network";
  else if (pendingQuery.error) buttonLabel = "Retry fee read";
  else if (feeReadPending) buttonLabel = "Reading fees";
  else if (pending > 0n) buttonLabel = "Distribute fees";

  return (
    <section className="pump-dev-fees" aria-labelledby="pump-fees-title">
      <div className="pump-dev-fees-heading">
        <div>
          <span className="pump-eyebrow">Open to anyone</span>
          <h2 id="pump-fees-title">Protocol fees</h2>
          <p>
            Creation and trading fees go 70% to NUSD stakers, 20% burned (raising NUSD backing) and
            10% to the treasury. Anyone can send them; curve reserves never move.
          </p>
        </div>
      </div>

      <div className="pump-dev-fees-grid">
        <div className="pump-dev-claimable">
          <span>Waiting to distribute</span>
          <strong>{pendingQuery.error || pendingQuery.data === undefined ? "--" : `${formatWad(pending, 6)} NUSD`}</strong>
          {pendingQuery.error ? <small>Could not read live protocol fees.</small> : <small>Held by the Pump contract until someone sends it</small>}
        </div>
        <dl className="pump-stats-list">
          <div>
            <dt>Fee splitter</dt>
            <dd title={recipientQuery.data}>{recipientQuery.data ? shortAddress(recipientQuery.data) : "--"}</dd>
          </div>
          <div>
            <dt>Split</dt>
            <dd>50% pool / 50% treasury</dd>
          </div>
          <div>
            <dt>Distributed lifetime</dt>
            <dd>{indexedTotalsAvailable && distributedFeesNusd ? `${formatWad(distributedFeesNusd, 6)} NUSD` : "--"}</dd>
          </div>
        </dl>
        <button
          className="pump-button pump-button-primary pump-button-large pump-button-full"
          type="button"
          disabled={!address || actionPending || feeReadPending || (!wrongChain && !pendingQuery.error && pending <= 0n)}
          onClick={() => void handleDistribute()}
        >
          {buttonLabel}
        </button>
      </div>
    </section>
  );
}

function StatsSkeleton() {
  return (
    <div className="pump-stats-loading" role="status" aria-label="Loading protocol statistics">
      <div className="pump-stats-source pump-skeleton-block" />
      <div className="pump-stats-primary">
        {Array.from({ length: 4 }).map((_, index) => (
          <div key={index} className="pump-stats-metric-skeleton" aria-hidden="true">
            <span />
            <strong />
            <small />
          </div>
        ))}
      </div>
      <div className="pump-stats-detail-grid">
        <div className="pump-stats-section pump-skeleton-block" />
        <div className="pump-stats-section pump-skeleton-block" />
      </div>
    </div>
  );
}
