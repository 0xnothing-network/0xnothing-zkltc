"use client";

import { useState } from "react";
import Link from "next/link";
import { usePumpMarkets, usePumpStats } from "@/features/pump/hooks/usePumpData";
import { formatWad } from "@/features/pump/format";
import type { PumpMarketSort, PumpStatus } from "@/features/pump/types";
import { TokenCard } from "@/features/pump/components/TokenCard";
import {
  PumpConfigNotice,
  PumpErrorState,
  PumpLoadingGrid,
} from "@/features/pump/components/PumpStates";

const FILTERS: Array<{ value: PumpStatus | "ALL"; label: string }> = [
  { value: "ALL", label: "All" },
  { value: "TRADING", label: "Trading" },
  { value: "READY", label: "Ready" },
  { value: "GRADUATED", label: "Graduated" },
];

const SORTS: Array<{ value: PumpMarketSort; label: string }> = [
  { value: "LAST_TRADE", label: "Last trade" },
  { value: "VOLUME", label: "Volume" },
  { value: "NEWEST", label: "Newest" },
];

export function PumpDiscover() {
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<PumpStatus | "ALL">("ALL");
  const [sort, setSort] = useState<PumpMarketSort>("LAST_TRADE");
  const query = usePumpMarkets({ limit: 200, search, status, sort });
  const trendingQuery = usePumpMarkets({ limit: 3, sort: "VOLUME" });
  const statsQuery = usePumpStats();
  const stats = statsQuery.data?.stats;
  const trendingMarkets = trendingQuery.markets
    .filter((market) => /^\d+$/.test(market.volumeNusd) && BigInt(market.volumeNusd) > 0n)
    .slice(0, 3);

  return (
    <main className="pump-page">
      {query.data?.configured === false ? <PumpConfigNotice /> : null}
      {query.data?.warning ? <p className="pump-source-note">{query.data.warning}</p> : null}
      {trendingQuery.data?.warning && trendingQuery.data.warning !== query.data?.warning ? <p className="pump-source-note">{trendingQuery.data.warning}</p> : null}
      {statsQuery.data?.warning && statsQuery.data.warning !== query.data?.warning ? <p className="pump-source-note">{statsQuery.data.warning}</p> : null}
      {statsQuery.error ? <p className="pump-source-note">Protocol totals are temporarily unavailable.</p> : null}

      <section className="pump-trending-section" aria-labelledby="pump-trending-title">
        <div className="pump-trending-heading">
          <h1 id="pump-trending-title">Trending</h1>
          <Link href="/0xpump/create" className="pump-button pump-button-primary">
            Create token
          </Link>
        </div>
        {trendingQuery.isLoading ? (
          <PumpLoadingGrid count={3} />
        ) : trendingQuery.error ? (
          <PumpErrorState message={trendingQuery.error.message} onRetry={() => void trendingQuery.refetch()} />
        ) : trendingMarkets.length ? (
          <div className="pump-token-grid pump-trending-grid">
            {trendingMarkets.map((market) => <TokenCard key={market.tokenAddress} market={market} />)}
          </div>
        ) : (
          <p className="pump-empty-inline">No traded markets yet.</p>
        )}
      </section>

      <section className="pump-stat-strip" aria-label="Protocol statistics">
        <div><span>Markets</span><strong>{stats?.marketCount ?? "--"}</strong></div>
        <div><span>Trading</span><strong>{stats?.tradingCount ?? "--"}</strong></div>
        <div><span>Ready</span><strong>{stats?.readyCount ?? "--"}</strong></div>
        <div><span>Volume</span><strong>{stats ? `${formatWad(stats.volumeNusd)} NUSD` : "--"}</strong></div>
      </section>

      <section className="pump-market-section">
        <div className="pump-market-toolbar">
          <div>
            <span className="pump-eyebrow">Live markets</span>
            <h2>Token feed</h2>
          </div>
          <div className="pump-market-controls">
            <div className="pump-segmented" role="group" aria-label="Market status filter">
              {FILTERS.map((filter) => (
                <button
                  key={filter.value}
                  type="button"
                  className={status === filter.value ? "active" : ""}
                  aria-pressed={status === filter.value}
                  onClick={() => setStatus(filter.value)}
                >
                  {filter.label}
                </button>
              ))}
            </div>
            <label className="pump-sort-select">
              <span className="sr-only">Sort token markets</span>
              <select
                value={sort}
                onChange={(event) => setSort(event.target.value as PumpMarketSort)}
              >
                {SORTS.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
            </label>
            <label className="pump-search">
              <span className="sr-only">Search token markets</span>
              <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="m16 16 4 4" /></svg>
              <input
                type="search"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search token"
                autoComplete="off"
                spellCheck={false}
              />
            </label>
            <span className="sr-only" aria-live="polite">{query.markets.length} markets found</span>
          </div>
        </div>

        {query.isLoading ? (
          <PumpLoadingGrid />
        ) : query.error ? (
          <PumpErrorState message={query.error.message} onRetry={() => void query.refetch()} />
        ) : query.markets.length ? (
          <div className="pump-token-grid">
            {query.markets.map((market) => <TokenCard key={market.tokenAddress} market={market} />)}
          </div>
        ) : (
          <div className="pump-empty-state">
            <span className="pump-eyebrow">No matches</span>
            <h2>No token markets in this view</h2>
            <p>Clear the filter or create the first market.</p>
          </div>
        )}
      </section>
    </main>
  );
}
