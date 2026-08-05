"use client";

import { useCallback, useEffect, useState } from "react";
import type { ActivityPoint, DataEnvelope } from "@fi/lib/data";
import { deployment } from "@fi/config/deployment";
import { EmptyState, ErrorState, PanelHeading, SkeletonRows } from "@fi/components/UiStates";
import { formatRelativeTimestamp } from "@fi/lib/format";
import { fiPath } from "@fi/config/paths";

function shortValue(value: string): string {
  return value.length > 12 ? `${value.slice(0, 7)}...${value.slice(-4)}` : value;
}

function isTransactionHash(value: string): boolean {
  return /^0x[0-9a-fA-F]{64}$/.test(value);
}

export function RecentActivity({ pair }: { pair: string }) {
  const [activity, setActivity] = useState<ActivityPoint[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();

  const load = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      const response = await fetch(fiPath(`/api/data/activity?pair=${encodeURIComponent(pair)}`), { cache: "no-store" });
      const payload = (await response.json()) as DataEnvelope<ActivityPoint[]> & { error?: string };
      if (!response.ok) throw new Error(payload.error || "Activity request failed");
      setActivity(payload.data);
    } catch (reason) {
      setActivity([]);
      setError(reason instanceof Error ? reason.message : "Activity request failed");
    } finally {
      setLoading(false);
    }
  }, [pair]);

  useEffect(() => { void load(); }, [load]);

  return (
    <section className="fi-panel fi-panel-flush">
      <PanelHeading title="Activity" />
      {loading ? <SkeletonRows count={5} label="Loading recent activity" /> : null}
      {!loading && error ? <ErrorState message={error} onRetry={() => void load()} /> : null}
      {!loading && !error && activity.length === 0 ? (
        <EmptyState title="No activity yet" />
      ) : null}
      {activity.length ? (
        <div className="fi-table-wrap">
          <table className="fi-table">
            <caption>Latest indexed activity for {pair}</caption>
            <thead><tr><th>Type</th><th>Amount</th><th>Time</th><th>Tx</th></tr></thead>
            <tbody>
              {activity.map((event) => (
                <tr key={event.id}>
                  <td><span className="fi-status" data-state={event.type === "swap" ? "live" : "warning"}>{event.type.toUpperCase()}</span></td>
                  <td>{event.amount0} / {event.amount1}</td>
                  <td>{formatRelativeTimestamp(event.timestamp)}</td>
                  <td>{isTransactionHash(event.transactionHash) ? <a className="fi-text-link" href={`${deployment.chain.explorerUrl}/tx/${event.transactionHash}`} target="_blank" rel="noreferrer">{shortValue(event.transactionHash)}</a> : "Invalid hash"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </section>
  );
}
