"use client";

import { useCallback, useMemo, useState } from "react";
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
  const trendingMarkets = trendingQuery.markets.slice(0, 3);

  const refetchMarkets = query.refetch;
  const refetchTrending = trendingQuery.refetch;
  const handleStatus = useCallback((value: PumpStatus | "ALL") => setStatus(value), []);
  const handleSort = useCallback((event: React.ChangeEvent<HTMLSelectElement>) => {
    setSort(event.target.value as PumpMarketSort);
  }, []);
  const handleSearch = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    setSearch(event.target.value);
  }, []);
  const handleRetry = useCallback(() => void refetchMarkets(), [refetchMarkets]);
  const handleTrendingRetry = useCallback(() => void refetchTrending(), [refetchTrending]);

  const trendingContent = useMemo(() => {
    if (trendingQuery.isLoading && !trendingQuery.data) return <PumpLoadingGrid count={3} />;
    if (trendingQuery.error && !trendingMarkets.length) {
      return <PumpErrorState message={trendingQuery.error.message} onRetry={handleTrendingRetry} />;
    }
    if (!trendingMarkets.length) return <p className="pump-empty-inline">No markets yet.</p>;
    return (
      <div className="pump-token-grid pump-trending-grid">
        {trendingMarkets.map((market) => <TokenCard key={market.tokenAddress} market={market} priority />)}
      </div>
    );
  }, [handleTrendingRetry, trendingMarkets, trendingQuery.data, trendingQuery.error, trendingQuery.isLoading]);

  const feedContent = useMemo(() => {
    if (query.isLoading && !query.data) return <PumpLoadingGrid />;
    if (query.error && !query.markets.length) {
      return <PumpErrorState message={query.error.message} onRetry={handleRetry} />;
    }
    if (!query.markets.length) {
      return (
        <div className="pump-empty-state">
          <span className="pump-eyebrow">No matches</span>
          <h2>No token markets in this view</h2>
          <p>Clear the filter or create the first market.</p>
        </div>
      );
    }
    return (
      <div className="pump-token-grid">
        {query.markets.map((market) => <TokenCard key={market.tokenAddress} market={market} />)}
      </div>
    );
  }, [handleRetry, query.data, query.error, query.isLoading, query.markets]);

  return (
    <main className="pump-page">
      {query.data?.configured === false ? <PumpConfigNotice /> : null}
      {query.data?.warning ? <p className="pump-source-note">{query.data.warning}</p> : null}
      {statsQuery.data?.warning && statsQuery.data.warning !== query.data?.warning ? <p className="pump-source-note">{statsQuery.data.warning}</p> : null}
      {statsQuery.error ? <p className="pump-source-note">Protocol totals are temporarily unavailable.</p> : null}

      <section className="pump-trending-section" aria-labelledby="pump-trending-title">
        <div className="pump-trending-heading">
          <h1 id="pump-trending-title">Trending</h1>
          <Link href="/0xPump/create" className="pump-button pump-button-primary">
            Create token
          </Link>
        </div>
        {trendingContent}
      </section>

      <section className="pump-stat-strip" aria-label="Protocol statistics">
        <div><span>Markets</span><strong>{stats?.marketCount ?? "--"}</strong></div>
        <div><span>Trading</span><strong>{stats?.tradingCount ?? "--"}</strong></div>
        <div><span>Ready</span><strong>{stats?.readyCount ?? "--"}</strong></div>
        <div><span>Volume</span><strong>{stats ? `$${formatWad(stats.volumeNusd)}` : "--"}</strong></div>
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
                  onClick={() => handleStatus(filter.value)}
                >
                  {filter.label}
                </button>
              ))}
            </div>
            <label className="pump-sort-select">
              <span className="sr-only">Sort token markets</span>
              <select value={sort} onChange={handleSort}>
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
                onChange={handleSearch}
                placeholder="Search token"
                autoComplete="off"
                spellCheck={false}
              />
            </label>
            <span className="sr-only" aria-live="polite">{query.markets.length} markets found</span>
          </div>
        </div>

        {feedContent}
      </section>
    </main>
  );
}
