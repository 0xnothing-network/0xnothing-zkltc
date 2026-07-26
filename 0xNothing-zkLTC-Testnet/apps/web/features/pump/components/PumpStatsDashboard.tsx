"use client";

import { useState } from "react";
import Link from "next/link";
import {
  useAccount,
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
  formatWad,
  shortAddress,
} from "@/features/pump/format";
import { usePumpMarkets, usePumpStats } from "@/features/pump/hooks/usePumpData";
import { PumpConfigNotice, PumpErrorState } from "@/features/pump/components/PumpStates";
import { useToast } from "@/components/Toast";
import { getTransactionExplorerUrl, publicClient } from "@/lib/contract";

function usd(value: string, fractionDigits = 2): string {
  return `$${formatWad(value, fractionDigits)}`;
}

export function PumpStatsDashboard() {
  const statsQuery = usePumpStats();
  const marketsQuery = usePumpMarkets({ limit: 5, sort: "VOLUME" });
  const { address } = useAccount();
  const adminQuery = useReadContract({
    address: PUMP_FACTORY_ADDRESS,
    abi: zeroXPumpAbi,
    functionName: "admin",
    chainId: PUMP_CHAIN_ID,
    query: {
      enabled: PUMP_CONFIGURED,
      staleTime: 30_000,
      refetchInterval: 30_000,
    },
  });
  const isAdmin = Boolean(
    address &&
    adminQuery.data &&
    address.toLowerCase() === adminQuery.data.toLowerCase(),
  );

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
                    <span className={`pump-status pump-status-${market.status.toLowerCase()}`}>{market.status}</span>
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

      {isAdmin && address && adminQuery.data ? (
        <DeveloperFeePanel
          address={address}
          admin={adminQuery.data}
          withdrawnFeesNusd={stats?.withdrawnFeesNusd}
          indexedTotalsAvailable={Boolean(stats && hasIndexedTotals)}
          onClaimed={() => void statsQuery.refetch()}
        />
      ) : address && adminQuery.error ? (
        <div className="pump-admin-check-error" role="alert">
          <span>Admin authorization could not be checked.</span>
          <button type="button" onClick={() => void adminQuery.refetch()}>Retry</button>
        </div>
      ) : null}
    </main>
  );
}

function DeveloperFeePanel({
  address,
  admin,
  withdrawnFeesNusd,
  indexedTotalsAvailable,
  onClaimed,
}: {
  address: `0x${string}`;
  admin: `0x${string}`;
  withdrawnFeesNusd?: string;
  indexedTotalsAvailable: boolean;
  onClaimed: () => void;
}) {
  const toast = useToast();
  const { chainId } = useAccount();
  const { switchChainAsync, isPending: isSwitching } = useSwitchChain();
  const { writeContractAsync } = useWriteContract();
  const [isClaiming, setIsClaiming] = useState(false);
  const wrongChain = chainId !== PUMP_CHAIN_ID;
  const claimableQuery = useReadContract({
    address: PUMP_FACTORY_ADDRESS,
    abi: zeroXPumpAbi,
    functionName: "accruedProtocolFeesNusd",
    chainId: PUMP_CHAIN_ID,
    query: {
      refetchInterval: 10_000,
      staleTime: 5_000,
    },
  });
  const claimable = claimableQuery.data ?? 0n;
  const actionPending = isClaiming || isSwitching;
  const feeReadPending = claimableQuery.isPending || claimableQuery.isFetching;

  const handleClaim = async () => {
    if (wrongChain) {
      try {
        await switchChainAsync({ chainId: PUMP_CHAIN_ID });
      } catch (error) {
        toast.handleError(error, "Network switch failed");
      }
      return;
    }
    if (claimableQuery.error || claimableQuery.data === undefined) {
      await claimableQuery.refetch();
      return;
    }
    if (claimable <= 0n || isClaiming) return;

    setIsClaiming(true);
    try {
      await publicClient.simulateContract({
        account: address,
        address: PUMP_FACTORY_ADDRESS,
        abi: zeroXPumpAbi,
        functionName: "withdrawProtocolFees",
        args: [address, claimable],
      });
      const hash = await writeContractAsync({
        address: PUMP_FACTORY_ADDRESS,
        abi: zeroXPumpAbi,
        functionName: "withdrawProtocolFees",
        args: [address, claimable],
        chainId: PUMP_CHAIN_ID,
      });
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") throw new Error("Fee claim transaction reverted.");

      toast.show({
        title: "Fees claimed",
        description: `${formatWad(claimable, 6)} NUSD was sent to ${shortAddress(address)}.`,
        kind: "success",
        href: getTransactionExplorerUrl(hash),
        hrefLabel: "View transaction",
      });
      await claimableQuery.refetch();
      onClaimed();
    } catch (error) {
      toast.handleError(error, "Fee claim failed");
    } finally {
      setIsClaiming(false);
    }
  };

  let buttonLabel = "Nothing to claim";
  if (actionPending) buttonLabel = isSwitching ? "Switching" : "Claiming";
  else if (wrongChain) buttonLabel = "Switch network";
  else if (claimableQuery.error) buttonLabel = "Retry fee read";
  else if (feeReadPending) buttonLabel = "Reading fees";
  else if (claimable > 0n) buttonLabel = "Claim all fees";

  return (
    <section className="pump-dev-fees" aria-labelledby="pump-dev-fees-title">
      <div className="pump-dev-fees-heading">
        <div>
          <span className="pump-eyebrow">Admin only</span>
          <h2 id="pump-dev-fees-title">Developer fees</h2>
          <p>Withdraws accrued creation and trading fees. Curve reserves remain locked to their markets.</p>
        </div>
        <span className="pump-dev-badge">Authorized wallet</span>
      </div>

      <div className="pump-dev-fees-grid">
        <div className="pump-dev-claimable">
          <span>Available to claim</span>
          <strong>{claimableQuery.error || claimableQuery.data === undefined ? "--" : `${formatWad(claimable, 6)} NUSD`}</strong>
          {claimableQuery.error ? <small>Could not read live protocol fees.</small> : <small>Live contract balance reserved for protocol fees</small>}
        </div>
        <dl className="pump-stats-list">
          <div>
            <dt>Admin</dt>
            <dd title={admin}>{shortAddress(admin)}</dd>
          </div>
          <div>
            <dt>Claimed lifetime</dt>
            <dd>{indexedTotalsAvailable && withdrawnFeesNusd ? `${formatWad(withdrawnFeesNusd, 6)} NUSD` : "--"}</dd>
          </div>
          <div>
            <dt>Recipient</dt>
            <dd title={address}>{shortAddress(address)}</dd>
          </div>
        </dl>
        <button
          className="pump-button pump-button-primary pump-button-large pump-button-full"
          type="button"
          disabled={actionPending || feeReadPending || (!wrongChain && !claimableQuery.error && claimable <= 0n)}
          onClick={() => void handleClaim()}
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
