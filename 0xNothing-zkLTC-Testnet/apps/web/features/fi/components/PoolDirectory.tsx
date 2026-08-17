"use client";

import Link from "next/link";
import { ArrowRight, CaretUpDown, MagnifyingGlass } from "@phosphor-icons/react";
import { useMemo, useState } from "react";
import type { Address } from "viem";
import { TokenPairLogos } from "@fi/components/TokenLogo";
import { EmptyState, ErrorState, SkeletonRows } from "@fi/components/UiStates";
import { deployment } from "@fi/config/deployment";
import { fiPath } from "@fi/config/paths";
import type { PoolPoint } from "@fi/lib/data";
import { usePools } from "@fi/lib/hooks/usePools";

type MarketFilter = "all" | "canonical" | "graduated";
type SortKey = "price" | "change" | "tvl";
type SortDirection = "asc" | "desc";
const EMPTY_POOLS: PoolPoint[] = [];

function normalizedSymbol(symbol: string): string {
  return symbol.toLowerCase() === "wzkltc" ? "zkLTC" : symbol;
}

function numberValue(value: string | undefined): number {
  if (!value) return 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function formatCompact(value: string | undefined, prefix = ""): string {
  if (value === undefined) return "--";
  const parsed = numberValue(value);
  if (parsed === 0) return `${prefix}0`;
  return `${prefix}${parsed.toLocaleString("en-US", {
    notation: Math.abs(parsed) >= 10_000 ? "compact" : "standard",
    maximumFractionDigits: Math.abs(parsed) < 0.0001 ? 12 : Math.abs(parsed) < 1 ? 8 : 2,
  })}`;
}

function formatPrice(value: string | undefined): string {
  if (value === undefined) return "--";
  const parsed = numberValue(value);
  if (parsed === 0) return "$0";
  const absolute = Math.abs(parsed);

  if (absolute >= 10_000) {
    return `$${parsed.toLocaleString("en-US", { notation: "compact", maximumSignificantDigits: 3 })}`;
  }
  if (absolute >= 1) {
    return `$${parsed.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
  }
  return `$${parsed.toLocaleString("en-US", { maximumSignificantDigits: 4 })}`;
}

function hasPositiveRawAmount(value: string | undefined): boolean {
  try {
    return BigInt(value || "0") > 0n;
  } catch {
    return false;
  }
}

function hasLiquidity(pool: PoolPoint): boolean {
  if (hasPositiveRawAmount(pool.totalSupply)) return true;
  return pool.bootstrapped
    && hasPositiveRawAmount(pool.reserve0)
    && hasPositiveRawAmount(pool.reserve1);
}

function canonicalPoolAddresses(): Set<string> {
  const addresses: Array<Address | undefined> = [
    deployment.contracts.wzkLtcNusdPair,
    deployment.contracts.nbtcNusdPair,
    deployment.contracts.nethNusdPair,
  ];
  return new Set(addresses.filter(Boolean).map((address) => address!.toLowerCase()));
}

function marketType(pool: PoolPoint, canonical: Set<string>): "canonical" | "graduated" | "other" {
  if (canonical.has(pool.id.toLowerCase())) return "canonical";
  if (pool.protectedBootstrap) return "graduated";
  return "other";
}

function sortValue(pool: PoolPoint, key: SortKey): number {
  if (key === "price") return numberValue(pool.priceNusd);
  if (key === "change") return pool.priceChange24h ?? Number.NEGATIVE_INFINITY;
  return numberValue(pool.tvlNusd);
}

function marketHref(pool: PoolPoint): string {
  if (
    deployment.contracts.wzkLtcNusdPair
    && pool.id.toLowerCase() === deployment.contracts.wzkLtcNusdPair.toLowerCase()
  ) {
    return fiPath("/pools/zkltc-nusd");
  }
  if (
    deployment.contracts.nbtcNusdPair
    && pool.id.toLowerCase() === deployment.contracts.nbtcNusdPair.toLowerCase()
  ) {
    return fiPath("/pools/nbtc-nusd");
  }
  if (
    deployment.contracts.nethNusdPair
    && pool.id.toLowerCase() === deployment.contracts.nethNusdPair.toLowerCase()
  ) {
    return fiPath("/pools/neth-nusd");
  }
  return fiPath(`/pools/${pool.id.toLowerCase()}`);
}

function MarketRow({ pool, canonical }: { pool: PoolPoint; canonical: Set<string> }) {
  const type = marketType(pool, canonical);
  const live = hasLiquidity(pool);
  const change = pool.priceChange24h;
  const nusd = deployment.contracts.nusd?.toLowerCase();
  const token0IsNusd = Boolean(nusd && pool.token0.id.toLowerCase() === nusd);
  const token1IsNusd = Boolean(nusd && pool.token1.id.toLowerCase() === nusd);
  const firstToken = token0IsNusd ? pool.token0 : token1IsNusd ? pool.token1 : pool.token0;
  const secondToken = token0IsNusd ? pool.token1 : token1IsNusd ? pool.token0 : pool.token1;
  const hasNusd = token0IsNusd || token1IsNusd;
  const displayToken0 = hasNusd ? secondToken : firstToken;
  const displayToken1 = hasNusd ? firstToken : secondToken;
  const firstSymbol = normalizedSymbol(displayToken0.symbol);
  const secondSymbol = normalizedSymbol(displayToken1.symbol);

  return (
    <li className="fi-market-item">
      <Link className="fi-market-row" href={marketHref(pool)}>
        <span className="fi-market-pair">
          <TokenPairLogos token0={displayToken0} token1={displayToken1} size="sm" />
          <span>
            <strong>{firstSymbol}<i>/</i>{secondSymbol}</strong>
            <small><i data-state={live ? "live" : "empty"} />{type === "graduated" ? "0xPump" : type === "canonical" ? "Core" : "DEX"}</small>
          </span>
          {hasPositiveRawAmount(pool.burnedLp) ? (
            <span className="fi-badge fi-badge-burn" title="LP burned permanently">Burned</span>
          ) : null}
        </span>
        <span className="fi-market-cell">
          <small>{firstSymbol} price</small>
          <strong>{formatPrice(pool.priceNusd)}</strong>
        </span>
        <span className="fi-market-cell" data-tone={change === undefined ? "muted" : change < 0 ? "danger" : "positive"}>
          <small>24h</small>
          <strong>{change === undefined ? "N/A" : `${change >= 0 ? "+" : ""}${change.toFixed(2)}%`}</strong>
        </span>
        <span className="fi-market-cell">
          <small>TVL</small>
          <strong>{formatCompact(pool.tvlNusd, "$")}</strong>
        </span>
        <ArrowRight className="fi-market-arrow" size={18} weight="bold" aria-hidden="true" />
      </Link>
    </li>
  );
}

export function PoolDirectory({
  tradeOnly = false,
  title = "Trade",
}: {
  tradeOnly?: boolean;
  title?: string;
}) {
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<MarketFilter>("all");
  const [sortKey, setSortKey] = useState<SortKey>("tvl");
  const [sortDirection, setSortDirection] = useState<SortDirection>("desc");

  const poolsQuery = usePools();
  const indexedPools = poolsQuery.data ?? EMPTY_POOLS;
  const loading = poolsQuery.isPending;
  const error = poolsQuery.isError && indexedPools.length === 0
    ? poolsQuery.error instanceof Error ? poolsQuery.error.message : "Pool request failed"
    : undefined;

  const canonical = useMemo(canonicalPoolAddresses, []);
  const markets = useMemo(() => {
    const query = search.trim().toLowerCase();
    return indexedPools
      .filter((pool) => {
        const type = marketType(pool, canonical);
        if (tradeOnly && type !== "canonical" && !hasLiquidity(pool)) return false;
        if (type === "other" && !hasLiquidity(pool)) return false;
        if (filter === "canonical" && type !== "canonical") return false;
        if (filter === "graduated" && type !== "graduated") return false;
        if (!query) return true;
        return [
          pool.id,
          pool.token0.id,
          pool.token1.id,
          pool.token0.symbol,
          pool.token1.symbol,
          pool.token0.name,
          pool.token1.name,
        ].some((value) => value.toLowerCase().includes(query));
      })
      .sort((a, b) => {
        const difference = sortValue(a, sortKey) - sortValue(b, sortKey);
        if (difference === 0) return a.id.localeCompare(b.id);
        return sortDirection === "asc" ? difference : -difference;
      });
  }, [canonical, filter, indexedPools, search, sortDirection, sortKey, tradeOnly]);

  function chooseSort(next: SortKey) {
    if (sortKey === next) setSortDirection((current) => current === "asc" ? "desc" : "asc");
    else {
      setSortKey(next);
      setSortDirection("desc");
    }
  }

  return (
    <section
      className="fi-market-explorer"
      aria-label={title ? undefined : "Pool markets"}
      aria-labelledby={title ? "fi-market-title" : undefined}
    >
      <div className="fi-market-toolbar">
        <div className="fi-market-title">
          {title ? <h1 id="fi-market-title">{title}</h1> : null}
          <span>{markets.length} markets</span>
        </div>
        <label className="fi-market-search">
          <span className="sr-only">Search markets</span>
          <MagnifyingGlass size={16} aria-hidden="true" />
          <input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search markets"
          />
        </label>
        <div className="fi-segmented" role="group" aria-label="Market type">
          {(["all", "canonical", "graduated"] as const).map((item) => (
            <button
              type="button"
              className={filter === item ? "active" : ""}
              onClick={() => setFilter(item)}
              aria-pressed={filter === item}
              key={item}
            >
              {item === "all" ? "All" : item === "canonical" ? "Core" : "0xPump"}
            </button>
          ))}
        </div>
      </div>

      <div className="fi-market-list-head">
        <span>Market</span>
        {(["price", "change", "tvl"] as const).map((key) => (
          <button
            type="button"
            data-active={sortKey === key || undefined}
            aria-label={sortKey === key
              ? `Sorted by ${key}, ${sortDirection === "asc" ? "ascending" : "descending"}. Change direction`
              : `Sort by ${key}`}
            aria-pressed={sortKey === key}
            onClick={() => chooseSort(key)}
            key={key}
          >
            {key === "change" ? "24h" : key.toUpperCase()}
            <CaretUpDown size={11} aria-hidden="true" />
          </button>
        ))}
        <span />
      </div>
      {poolsQuery.warning ? (
        <div className="fi-inline-state fi-inline-warning" role="status">
          <div><strong>Market data delayed</strong><span>Showing the latest available snapshot.</span></div>
        </div>
      ) : null}
      <ul className="fi-market-list">
        {markets.map((pool) => <MarketRow pool={pool} canonical={canonical} key={pool.id} />)}
      </ul>
      {loading && indexedPools.length === 0 ? <SkeletonRows count={4} label="Loading DEX markets" /> : null}
      {!loading && error ? <ErrorState message={error} onRetry={() => void poolsQuery.refetch()} /> : null}
      {!loading && !error && markets.length === 0 ? (
        <EmptyState title={indexedPools.length === 0 ? "No markets yet" : "No matching markets"} />
      ) : null}
    </section>
  );
}
