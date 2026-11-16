"use client";

import { memo, useId } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowUpRight } from "@phosphor-icons/react";
import type { ActivityPoint, DataEnvelope } from "@fi/lib/data";
import { deployment } from "@fi/config/deployment";
import { EmptyState, ErrorState, PanelHeading, SkeletonRows } from "@fi/components/UiStates";
import { formatRelativeTimestamp } from "@fi/lib/format";
import { fiPath } from "@fi/config/paths";
import { fetchJson } from "@/lib/http";
import { FI_LIVE_MS } from "@/lib/liveData";
import { fiPollInterval, useFiVisibilityRefresh } from "@fi/lib/hooks/useFiPolling";

function shortValue(value: string): string {
  return value.length > 12 ? `${value.slice(0, 7)}...${value.slice(-4)}` : value;
}

function isTransactionHash(value: string): boolean {
  return /^0x[0-9a-fA-F]{64}$/.test(value);
}

function formatActivityAmount(value: string): string {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return value;
  const magnitude = Math.abs(parsed);
  const signed = value.trim().startsWith("+");
  // Display cap: 6 significant digits; dust below 0.000001 reads as "<0.000001".
  if (magnitude > 0 && magnitude < 0.000001) return `${parsed < 0 ? "-" : signed ? "+" : ""}<0.000001`;
  return parsed.toLocaleString("en-US", magnitude >= 1_000_000
    ? { maximumFractionDigits: 0, signDisplay: signed ? "always" : "auto" }
    : { maximumSignificantDigits: 6, signDisplay: signed ? "always" : "auto" });
}

async function fetchActivity(pair: string, signal: AbortSignal): Promise<ActivityPoint[]> {
  const payload = await fetchJson<DataEnvelope<ActivityPoint[]>>(
    fiPath(`/api/data/activity?pair=${encodeURIComponent(pair)}`),
    { signal },
    "Activity request failed",
  );
  return payload.data;
}

export const RecentActivity = memo(function RecentActivity({ pair }: { pair: string }) {
  const captionId = useId();
  const pollKey = `activity:${pair.toLowerCase()}`;
  const query = useQuery({
    queryKey: ["fi-activity", pair],
    queryFn: ({ signal }) => fetchActivity(pair, signal),
    staleTime: 12_000,
    refetchInterval: () => fiPollInterval(pollKey),
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: false,
  });
  useFiVisibilityRefresh({
    key: pollKey,
    dataUpdatedAt: query.dataUpdatedAt,
    isFetching: query.isFetching,
    refetch: query.refetch,
    maxAgeMs: FI_LIVE_MS,
  });
  const activity = query.data ?? [];

  return (
    <section className="fi-panel fi-panel-flush">
      <PanelHeading title="Activity" />
      {query.isLoading ? <SkeletonRows count={5} label="Loading recent activity" /> : null}
      {!query.isLoading && query.error ? <ErrorState message={query.error.message} onRetry={() => void query.refetch()} /> : null}
      {!query.isLoading && !query.error && activity.length === 0 ? (
        <EmptyState title="No activity yet" />
      ) : null}
      {activity.length ? (
        <div className="fi-table-wrap" tabIndex={0} role="region" aria-labelledby={captionId}>
          <table className="fi-table fi-activity-table">
            <caption id={captionId}>Latest indexed activity for {pair}</caption>
            <thead><tr><th scope="col">Type</th><th scope="col">Amount</th><th scope="col">Time</th><th scope="col">Tx</th></tr></thead>
            <tbody>
              {activity.map((event) => (
                <tr key={event.id}>
                  <td><span className="fi-status">{event.type.charAt(0).toUpperCase() + event.type.slice(1)}</span></td>
                  <td title={`${event.amount0} / ${event.amount1}`}>
                    {formatActivityAmount(event.amount0)} / {formatActivityAmount(event.amount1)}
                  </td>
                  <td>{formatRelativeTimestamp(event.timestamp)}</td>
                  <td>{isTransactionHash(event.transactionHash) ? <a className="fi-text-link" href={`${deployment.chain.explorerUrl}/tx/${event.transactionHash}`} target="_blank" rel="noopener noreferrer">{shortValue(event.transactionHash)}<ArrowUpRight size={12} weight="bold" aria-hidden="true" /></a> : "Invalid hash"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </section>
  );
});
