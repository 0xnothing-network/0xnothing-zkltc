"use client";

import type { Address } from "viem";
import { usePumpTrades } from "@/features/pump/hooks/usePumpData";
import { formatDecimal, formatRelativeTime, formatWad, shortAddress } from "@/features/pump/format";
import { PumpErrorState, PumpInlineLoading } from "@/features/pump/components/PumpStates";

export function TradeHistory({ token }: { token: Address }) {
  const query = usePumpTrades(token, 60);
  return (
    <section className="pump-panel pump-history">
      <div className="pump-panel-heading">
        <div><span className="pump-eyebrow">On-chain activity</span><h2>Recent trades</h2></div>
        <span className="pump-source-label">{query.data?.source ?? "loading"}</span>
      </div>
      {query.error ? <PumpErrorState message={query.error.message} onRetry={() => void query.refetch()} /> : query.isLoading ? (
        <PumpInlineLoading label="Loading recent trades" />
      ) : (
        <div className="pump-table-wrap" tabIndex={0} aria-label="Recent trades table, scroll horizontally for all columns">
          <table className="pump-table">
            <caption className="sr-only">Recent indexed trades for this token</caption>
            <thead><tr><th>Side</th><th>NUSD</th><th>Tokens</th><th>Price</th><th>Fee</th><th>Trader</th><th>Time</th></tr></thead>
            <tbody>
              {(query.data?.trades ?? []).map((trade) => (
                <tr key={trade.id}>
                  <td><span className={`pump-side pump-side-${trade.side.toLowerCase()}`}>{trade.side}</span></td>
                  <td>{formatWad(trade.nusdAmount, 4)}</td>
                  <td>{formatWad(trade.tokenAmount, 4)}</td>
                  <td>{formatDecimal(trade.priceNusd)}</td>
                  <td>{formatWad(trade.feeNusd, 5)}</td>
                  <td><span title={trade.trader}>{shortAddress(trade.trader)}</span></td>
                  <td>{formatRelativeTime(trade.timestamp)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!query.isLoading && !query.data?.trades.length ? <div className="pump-table-empty">No indexed trades yet.</div> : null}
        </div>
      )}
    </section>
  );
}
