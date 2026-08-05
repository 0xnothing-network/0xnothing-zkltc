"use client";

import Link from "next/link";
import { ArrowRight, CaretUpDown, MagnifyingGlass } from "@phosphor-icons/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { Address } from "viem";
import { TokenPairLogos } from "@/components/TokenLogo";
import { EmptyState, ErrorState, SkeletonRows } from "@/components/UiStates";
import { deployment } from "@/config/deployment";
import { fiPath } from "@/config/paths";
import type { DataEnvelope, PoolPoint } from "@/lib/data";

type MarketFilter = "all" | "canonical" | "graduated";
type SortKey = "price" | "change" | "tvl";
type SortDirection = "asc" | "desc";

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

function MarketRow({ pool, canonical }: { pool: PoolPoint; canonical: Set<string> }) {
  const type = marketType(pool, canonical);
  const live = hasLiquidity(pool);
  const change = pool.priceChange24h;
  const nusd = deployment.contracts.nusd?.toLowerCase();
  const quoteFirst = Boolean(nusd && pool.token0.id.toLowerCase() === nusd);
  const baseToken = quoteFirst ? pool.token1 : pool.token0;
  const quoteToken = quoteFirst ? pool.token0 : pool.token1;
  const token0 = normalizedSymbol(baseToken.symbol);
  const token1 = normalizedSymbol(quoteToken.symbol);

  return (
    <Link className="fi-market-row" href={`/pools/${pool.id.toLowerCase()}`} role="listitem">
      <span className="fi-market-pair">
        <TokenPairLogos token0={baseToken} token1={quoteToken} size="sm" />
        <span>
          <strong>{token0}<i>/</i>{token1}</strong>
          <small><i data-state={live ? "live" : "empty"} />{type === "graduated" ? "0xPump" : type === "canonical" ? "Core" : "DEX"}</small>
        </span>
      </span>
      <span className="fi-market-cell">
        <small>Price</small>
        <strong>{formatCompact(pool.priceNusd, "$")}</strong>
      </span>
      <span className="fi-market-cell" data-tone={change === undefined ? "muted" : change < 0 ? "danger" : "positive"}>
        <small>24h</small>
        <strong>{change === undefined ? "--" : `${change >= 0 ? "+" : ""}${change.toFixed(2)}%`}</strong>
      </span>
      <span className="fi-market-cell">
        <small>TVL</small>
        <strong>{formatCompact(pool.tvlNusd, "$")}</strong>
      </span>
      <ArrowRight className="fi-market-arrow" size={18} weight="bold" aria-hidden="true" />
    </Link>
  );
}

export function PoolDirectory({
  tradeOnly = false,
  title = "Trade",
}: {
  tradeOnly?: boolean;
  title?: string;
}) {
  const [indexedPools, setIndexedPools] = useState<PoolPoint[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<MarketFilter>("all");
  const [sortKey, setSortKey] = useState<SortKey>("tvl");
  const [sortDirection, setSortDirection] = useState<SortDirection>("desc");

  const load = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      const response = await fetch(fiPath("/api/data/pools"), { cache: "no-store" });
      const payload = (await response.json()) as DataEnvelope<PoolPoint[]> & { error?: string };
      if (!response.ok) throw new Error(payload.error || "Pool request failed");
      setIndexedPools(payload.data);
    } catch (reason) {
      setIndexedPools([]);
      setError(reason instanceof Error ? reason.message : "Pool request failed");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 30_000);
    return () => window.clearInterval(timer);
  }, [load]);

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
    <section className="fi-market-explorer" aria-labelledby="fi-market-title">
      <div className="fi-market-toolbar">
        <div className="fi-market-title">
          <h1 id="fi-market-title">{title}</h1>
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
            aria-label={`Sort by ${key}`}
            onClick={() => chooseSort(key)}
            key={key}
          >
            {key === "change" ? "24h" : key.toUpperCase()}
            <CaretUpDown size={11} aria-hidden="true" />
          </button>
        ))}
        <span />
      </div>
      <div className="fi-market-list" role="list">
        {markets.map((pool) => <MarketRow pool={pool} canonical={canonical} key={pool.id} />)}
      </div>
      {loading && indexedPools.length === 0 ? <SkeletonRows count={4} label="Loading DEX markets" /> : null}
      {!loading && error ? <ErrorState message={error} onRetry={() => void load()} /> : null}
      {!loading && !error && markets.length === 0 ? (
        <EmptyState title={indexedPools.length === 0 ? "No markets yet" : "No matching markets"} />
      ) : null}
    </section>
  );
}
