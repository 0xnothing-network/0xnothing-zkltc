"use client";

import type { Address } from "viem";
import { getAddressExplorerUrl } from "@/lib/explorer";
import { formatSupplyPercentage, formatTokenAmount, shortAddress } from "@/features/pump/format";
import { usePumpHolders } from "@/features/pump/hooks/usePumpData";
import { PumpErrorState, PumpInlineLoading } from "@/features/pump/components/PumpStates";

const HOLDER_LIMIT = 10;

export function TokenHolders({ token, symbol }: { token: Address; symbol: string }) {
  const query = usePumpHolders(token, HOLDER_LIMIT);
  const data = query.data;

  const activeHolders = data?.holders ?? [];
  const creatorIsActive = data
    ? activeHolders.some((holder) => holder.account.toLowerCase() === data.creator.toLowerCase())
    : false;
  const visibleHolders = data && !creatorIsActive
    ? [...activeHolders, { account: data.creator, balance: "0", isCreator: true }]
    : activeHolders;

  return (
    <section className="pump-panel pump-holders">
      <div className="pump-panel-heading">
        <div>
          <span className="pump-eyebrow">Distribution</span>
          <h2>Top holders</h2>
        </div>
        <div className="pump-holder-heading-meta">
          <span className="pump-holder-count">
            {data ? `${data.holderCount} active holder${data.holderCount === 1 ? "" : "s"}` : "Loading holders"}
          </span>
        </div>
      </div>

      {data?.warning ? <p className="pump-source-note pump-holder-warning">{data.warning}</p> : null}

      {query.error ? (
        <PumpErrorState message={query.error.message} onRetry={() => void query.refetch()} />
      ) : query.isLoading || !data ? (
        <PumpInlineLoading label="Loading token holders" />
      ) : (
        <div className="pump-holder-grid" role="table" aria-label={`Top holders of ${symbol}`}>
          <div className="pump-holder-row pump-holder-head" role="row">
            <span role="columnheader">#</span>
            <span role="columnheader">Holder</span>
            <span role="columnheader">Balance</span>
            <span role="columnheader">Supply</span>
          </div>

          <div className="pump-holder-row pump-holder-system" role="row">
            <span className="pump-holder-rank" role="cell">--</span>
            <span className="pump-holder-identity" role="cell">
              <strong>Bonding curve</strong>
              <small>Protocol inventory <em className="pump-holder-badge pump-holder-badge-system">Curve</em></small>
            </span>
            <span className="pump-holder-balance" role="cell">{formatTokenAmount(toBigInt(data.curveBalance))} {symbol}</span>
            <strong className="pump-holder-share" role="cell">{formatSupplyPercentage(data.curveBalance, data.totalSupply)}</strong>
          </div>

          {visibleHolders.map((holder, index) => {
            const isActive = toBigInt(holder.balance) > 0n;
            const hasKnownRank = isActive && index < HOLDER_LIMIT;
            return (
              <div className="pump-holder-row" role="row" key={holder.account}>
                <span className="pump-holder-rank" role="cell">{hasKnownRank ? index + 1 : "--"}</span>
                <span className="pump-holder-identity" role="cell">
                  <a href={getAddressExplorerUrl(holder.account)} target="_blank" rel="noopener noreferrer" title={holder.account}>
                    {shortAddress(holder.account, 7, 6)}
                  </a>
                  {holder.isCreator || !isActive || (isActive && !hasKnownRank) ? (
                    <small>
                      {holder.isCreator ? <em className="pump-holder-badge">Creator</em> : null}
                      {!isActive ? <span>Not currently holding</span> : null}
                      {isActive && !hasKnownRank ? <span>Outside top {HOLDER_LIMIT}</span> : null}
                    </small>
                  ) : null}
                </span>
                <span className="pump-holder-balance" role="cell">{formatTokenAmount(toBigInt(holder.balance))} {symbol}</span>
                <strong className="pump-holder-share" role="cell">{formatSupplyPercentage(holder.balance, data.totalSupply)}</strong>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

function toBigInt(value: string) {
  try {
    return BigInt(value);
  } catch {
    return 0n;
  }
}
