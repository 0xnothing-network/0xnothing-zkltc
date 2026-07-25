"use client";

import { useEffect, useState, useCallback, useMemo, useRef } from "react";
import { useAccount, usePublicClient, useSwitchChain, useWriteContract, useWaitForTransactionReceipt } from "wagmi";
import { formatEther } from "viem";
import {
  PIXEL_MARKETPLACE_ADDRESS,
  PIXEL_NFT_CONTRACT_ADDRESS,
  shortenAddress,
  getMarketplaceTxUrl,
  getTokenExplorerUrl,
} from "@/lib/contract";
import { MarketplaceAbi, marketplaceNftKey, type RawListing } from "@/lib/marketplaceAbi";
import { GridSkeleton } from "@/components/Skeleton";
import { useToast } from "@/components/Toast";
import { LITVM_CHAIN_ID } from "@/lib/chainSwitch";

type SortKey = "newest" | "price-asc" | "price-desc";
type ActivityFilter = "all" | "sold" | "minted" | "listed" | "cancelled";
type MarketActivityType = "MINTED" | "LISTED" | "BOUGHT" | "CANCELLED";

interface TokenMetadata {
  tokenId: string;
  name: string;
  imageUrl: string;
  creator: string;
  mintedAt: number;
}

interface ListingsResponse {
  listings: Array<{
    listingId: string;
    collection: `0x${string}`;
    tokenId: string;
    price: string;
    seller: `0x${string}`;
    active: boolean;
  }>;
  tokens: Record<string, TokenMetadata | null>;
}

interface MarketActivityEvent {
  id: string;
  listingId: string;
  tokenId: string;
  eventType: MarketActivityType;
  price: string | null;
  seller: `0x${string}` | null;
  buyer: `0x${string}` | null;
  timestamp: number;
  blockNumber: number;
  txHash: `0x${string}`;
  token: TokenMetadata | null;
}

interface ActivityResponse {
  events: MarketActivityEvent[];
  error?: string;
}

const PAGE_SIZE = 20;
const ACTIVITY_PAGE_SIZE = 24;

const ACTIVITY_FILTERS: Array<{ key: ActivityFilter; label: string }> = [
  { key: "all", label: "All" },
  { key: "sold", label: "Sold" },
  { key: "minted", label: "Minted" },
  { key: "listed", label: "Listed" },
  { key: "cancelled", label: "Cancelled" },
];

export default function MarketplacePage() {
  const { address } = useAccount();

  return (
    <div className="min-h-[calc(100vh-64px)] max-w-7xl mx-auto px-3 py-5 sm:px-4 sm:py-6" style={{ fontFamily: "var(--font-departure)" }}>
      <MarketplaceHeader />
      <MarketplaceBody userAddress={address} />
    </div>
  );
}

function MarketplaceHeader() {
  return (
    <header className="mb-4 sm:mb-5">
      <h1
        className="text-2xl sm:text-3xl font-bold text-white"
        style={{ fontFamily: "var(--font-departure)" }}
      >
        Marketplace
      </h1>
    </header>
  );
}

interface BodyProps {
  userAddress: `0x${string}` | undefined;
}

function MarketplaceBody({ userAddress }: BodyProps) {
  const [sort, setSort] = useState<SortKey>("newest");
  const [page, setPage] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<ListingsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [reloadKey, setReloadKey] = useState(0);
  const [activityRefreshKey, setActivityRefreshKey] = useState(0);
  const abortRef = useRef<AbortController | null>(null);
  const forceRefreshRef = useRef(false);

  // Cache for API responses (persists across renders)
  const cacheRef = useRef<{ data: ListingsResponse | null; timestamp: number }>({ data: null, timestamp: 0 });
  const CACHE_DURATION = 15_000; // 15 seconds

  const fetchListings = useCallback(async (force = false) => {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setLoading(true);
    setError(null);
    try {
      // Check cache first
      const now = Date.now();
      if (!force && cacheRef.current.data && now - cacheRef.current.timestamp < CACHE_DURATION) {
        setData(cacheRef.current.data);
        setLoading(false);
        return;
      }

      const url = force
        ? `/api/marketplace/listings?force=1&t=${Date.now()}`
        : "/api/marketplace/listings";
      const r = await fetch(url, {
        signal: ctrl.signal,
        cache: force ? "no-store" : "default",
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const body = (await r.json()) as ListingsResponse;
      cacheRef.current = { data: body, timestamp: Date.now() };
      setData(body);
    } catch (err) {
      if ((err as { name?: string }).name === "AbortError") return;
      console.error("[marketplace] load failed:", err);
      setError("Couldn't load listings. Please retry.");
    } finally {
      if (!ctrl.signal.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const force = forceRefreshRef.current;
    forceRefreshRef.current = false;
    void fetchListings(force);
    return () => abortRef.current?.abort();
  }, [fetchListings, reloadKey]);

  const listings: RawListing[] = useMemo(() => {
    if (!data) return [];
    return data.listings
      .filter((l) => l.active)
      .map((l) => ({
        listingId: BigInt(l.listingId),
        collection: l.collection,
        tokenId: BigInt(l.tokenId),
        price: BigInt(l.price),
        seller: l.seller,
        active: l.active,
      }));
  }, [data]);

  const sorted = useMemo(() => {
    const arr = [...listings];
    switch (sort) {
      case "price-asc":
        arr.sort((a, b) => (a.price === b.price ? 0 : a.price < b.price ? -1 : 1));
        break;
      case "price-desc":
        arr.sort((a, b) => (a.price === b.price ? 0 : a.price > b.price ? -1 : 1));
        break;
      case "newest":
      default:
        arr.sort((a, b) => (a.listingId === b.listingId ? 0 : a.listingId > b.listingId ? -1 : 1));
    }
    return arr;
  }, [listings, sort]);

  const totalPages = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const pageItems = sorted.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);

  const handleRefresh = useCallback(() => {
    cacheRef.current = { data: null, timestamp: 0 };
    forceRefreshRef.current = true;
    setPage(1);
    setReloadKey((k) => k + 1);
    setActivityRefreshKey((k) => k + 1);
  }, []);

  const handleActionComplete = useCallback(() => {
    handleRefresh();
  }, [handleRefresh]);

  return (
    <div className="space-y-5 sm:space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="text-sm text-[#94A3B8]" style={{ fontFamily: "var(--font-departure)" }}>
          {loading && !data
            ? "Loading..."
            : sorted.length === 0
            ? "No listings"
            : `${sorted.length} listing${sorted.length === 1 ? "" : "s"}`}
        </div>
        <div className="grid w-full grid-cols-[minmax(0,1fr)_2.75rem] items-center gap-2 sm:flex sm:w-auto">
          <select
            value={sort}
            onChange={(e) => {
              setSort(e.target.value as SortKey);
              setPage(1);
            }}
            className="h-11 min-w-0 flex-1 bg-[#0F0F23] border border-[#2D2D44] text-white text-sm rounded-lg px-3 focus:outline-none focus:border-[#8888ff] sm:h-10 sm:flex-none"
            style={{ fontFamily: "var(--font-departure)" }}
          >
            <option value="newest">Newest</option>
            <option value="price-asc">Price: low to high</option>
            <option value="price-desc">Price: high to low</option>
          </select>
          <button
            onClick={handleRefresh}
            aria-busy={loading || undefined}
            className="pixel-btn-soft pixel-btn-soft-indigo inline-grid h-11 w-11 shrink-0 place-items-center p-0 transition-colors sm:h-10 sm:w-10"
            aria-label="Refresh"
            title="Refresh"
          >
            <svg
              className={loading ? "animate-spin" : ""}
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <path d="M21 12a9 9 0 0 0-9-9M3 12a9 9 0 0 0 9 9" />
              <path d="M21 3v6h-6M3 21v-6h6" />
            </svg>
          </button>
        </div>
      </div>

      {error ? (
        <div className="text-center py-20">
          <p className="text-red-400 mb-4" style={{ fontFamily: "var(--font-departure)" }}>{error}</p>
          <button
            onClick={handleRefresh}
            className="px-4 py-2 bg-[#8888ff] hover:bg-indigo-600 text-white rounded-lg"
            style={{ fontFamily: "var(--font-departure)" }}
          >
            Retry
          </button>
        </div>
      ) : loading && !data ? (
        <GridSkeleton count={8} />
      ) : sorted.length === 0 ? (
        <EmptyState />
      ) : (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3 sm:gap-6">
            {pageItems.map((nft) => (
              <ListingCard
                key={nft.listingId.toString()}
                listing={nft}
                userAddress={userAddress}
                meta={data?.tokens[marketplaceNftKey(nft.collection, nft.tokenId)] ?? null}
                onActionComplete={handleActionComplete}
              />
            ))}
          </div>
          {totalPages > 1 && (
            <Pagination page={safePage} totalPages={totalPages} onChange={setPage} />
          )}
        </>
      )}

      <MarketplaceActivity refreshKey={activityRefreshKey} />
    </div>
  );
}

function Pagination({ page, totalPages, onChange }: { page: number; totalPages: number; onChange: (p: number) => void }) {
  return (
    <div className="flex items-center justify-center gap-2 pt-4">
      <button
        onClick={() => onChange(Math.max(1, page - 1))}
        disabled={page <= 1}
        className="min-h-11 px-4 py-3 sm:py-2 bg-[#1A1A2E] border border-[#2D2D44] rounded-lg text-white disabled:opacity-50 hover:border-[#8888ff]/50 transition-colors"
        style={{ fontFamily: "var(--font-departure)" }}
      >
        Prev
      </button>
      <span className="text-sm text-[#94A3B8] px-3" style={{ fontFamily: "var(--font-departure)" }}>{page} / {totalPages}</span>
      <button
        onClick={() => onChange(Math.min(totalPages, page + 1))}
        disabled={page >= totalPages}
        className="min-h-11 px-4 py-3 sm:py-2 bg-[#1A1A2E] border border-[#2D2D44] rounded-lg text-white disabled:opacity-50 hover:border-[#8888ff]/50 transition-colors"
        style={{ fontFamily: "var(--font-departure)" }}
      >
        Next
      </button>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="text-center py-20">
      <div className="w-24 h-24 mx-auto mb-6 bg-[#1A1A2E] rounded-2xl flex items-center justify-center border border-[#2D2D44]">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#6366F1" strokeWidth="1.5">
          <path strokeLinecap="round" strokeLinejoin="round" d="M3 3h18v18H3z M3 9h18 M9 21V9" />
        </svg>
      </div>
      <h2 className="text-xl font-bold text-white mb-2" style={{ fontFamily: "var(--font-departure)" }}>No active listings</h2>
      <p className="text-[#94A3B8] mb-6" style={{ fontFamily: "var(--font-departure)" }}>Be the first to list your 0xPIXEL NFT</p>
      <a
        href="/0xpixel"
        className="inline-block px-6 py-3 bg-[#8888ff] hover:bg-indigo-600 text-white font-bold rounded-lg transition-colors"
        style={{ fontFamily: "var(--font-departure)" }}
      >
        Create one now
      </a>
    </div>
  );
}

function MarketplaceActivity({ refreshKey = 0 }: { refreshKey?: number }) {
  const [filter, setFilter] = useState<ActivityFilter>("all");
  const [events, setEvents] = useState<MarketActivityEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const fetchActivity = useCallback(async (skip = 0, force = false) => {
    if (skip === 0) {
      abortRef.current?.abort();
    }

    const ctrl = new AbortController();
    abortRef.current = ctrl;

    if (skip === 0) {
      setLoading(true);
      setError(null);
    } else {
      setLoadingMore(true);
    }

    try {
      const params = new URLSearchParams({
        limit: ACTIVITY_PAGE_SIZE.toString(),
        skip: skip.toString(),
      });
      const type = activityFilterToType(filter);
      if (type) params.set("type", type);
      if (force) params.set("force", "1");

      const r = await fetch(`/api/marketplace/activity?${params.toString()}`, {
        signal: ctrl.signal,
        cache: force ? "no-store" : "default",
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const body = (await r.json()) as ActivityResponse;

      setEvents((prev) =>
        skip > 0 ? appendUniqueEvents(prev, body.events) : body.events
      );
      setHasMore(body.events.length === ACTIVITY_PAGE_SIZE);
    } catch (err) {
      if ((err as { name?: string }).name === "AbortError") return;
      console.error("[marketplace] activity load failed:", err);
      setError("Couldn't load marketplace history.");
    } finally {
      if (ctrl.signal.aborted) return;
      if (skip === 0) setLoading(false);
      else setLoadingMore(false);
    }
  }, [filter]);

  useEffect(() => {
    setEvents([]);
    setHasMore(false);
    void fetchActivity(0, refreshKey > 0);
    return () => abortRef.current?.abort();
  }, [fetchActivity, refreshKey]);

  const handleLoadMore = useCallback(() => {
    if (loading || loadingMore) return;
    void fetchActivity(events.length);
  }, [events.length, fetchActivity, loading, loadingMore]);

  return (
    <section className="overflow-hidden rounded-xl sm:rounded-2xl border border-[#2D2D44] bg-[#101026]/90 shadow-2xl shadow-black/10">
      <div className="border-b border-[#2D2D44] p-4 sm:p-5">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div className="min-w-0">
            <p className="text-[10px] uppercase tracking-wider text-[#8888ff]" style={{ fontFamily: "var(--font-departure)" }}>
              NFT history
            </p>
            <h2 className="mt-1 text-lg sm:text-xl font-bold text-white" style={{ fontFamily: "var(--font-departure)" }}>
              Recent marketplace activity
            </h2>
            {loading && (
              <p className="mt-1 text-xs sm:text-sm text-[#64748B]" style={{ fontFamily: "var(--font-departure)" }}>
                syncing....
              </p>
            )}
          </div>

          <div className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-0.5">
            {ACTIVITY_FILTERS.map((item) => {
              const active = filter === item.key;
              return (
                <button
                  key={item.key}
                  onClick={() => setFilter(item.key)}
                  className={
                    active
                      ? "shrink-0 rounded-lg border border-[#8888ff]/50 bg-[#8888ff]/20 px-3 py-2 text-xs font-bold text-white"
                      : "shrink-0 rounded-lg border border-[#2D2D44] bg-[#17172f] px-3 py-2 text-xs font-bold text-[#94A3B8] transition-colors hover:border-[#8888ff]/40 hover:text-white"
                  }
                  style={{ fontFamily: "var(--font-departure)" }}
                >
                  {item.label}
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {error ? (
        <div className="p-5 text-center">
          <p className="text-sm text-red-300" style={{ fontFamily: "var(--font-departure)" }}>
            {error}
          </p>
          <button
            onClick={() => void fetchActivity(0, true)}
            className="mt-3 rounded-lg bg-[#8888ff] px-4 py-2.5 text-xs font-bold text-white transition-colors hover:bg-[#AAAADD]"
            style={{ fontFamily: "var(--font-departure)" }}
          >
            Retry
          </button>
        </div>
      ) : loading ? (
        <ActivitySkeleton />
      ) : events.length === 0 ? (
        <ActivityEmpty />
      ) : (
        <>
          <div className="divide-y divide-[#2D2D44]">
            {events.map((event) => (
              <ActivityRow key={event.id} event={event} />
            ))}
          </div>

          {hasMore ? (
            <div className="border-t border-[#2D2D44] p-4 text-center">
              <button
                onClick={handleLoadMore}
                disabled={loadingMore}
                className="rounded-lg bg-[#1A1A2E] border border-[#2D2D44] px-4 py-2.5 text-xs font-bold text-white transition-colors hover:border-[#8888ff]/50 disabled:opacity-50"
                style={{ fontFamily: "var(--font-departure)" }}
              >
                {loadingMore ? "Loading..." : "Load more"}
              </button>
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}

function ActivityRow({ event }: { event: MarketActivityEvent }) {
  const label = activityLabel(event.eventType);
  const tone = activityTone(event.eventType);
  const tokenName = event.token?.name || `Token #${event.tokenId}`;
  const actorText = activityActorText(event);
  const hasTxHash = event.txHash !== "0x0000000000000000000000000000000000000000000000000000000000000000";

  return (
    <article className="marketplace-activity-row grid grid-cols-[44px_minmax(0,1fr)] gap-3 p-3 sm:grid-cols-[56px_minmax(0,1fr)_auto] sm:items-center sm:gap-4 sm:p-4">
      <a
        href={getTokenExplorerUrl(PIXEL_NFT_CONTRACT_ADDRESS, event.tokenId)}
        target="_blank"
        rel="noopener noreferrer"
        className="h-11 w-11 overflow-hidden rounded-lg border border-[#2D2D44] bg-[#0F0F23] sm:h-14 sm:w-14"
      >
        {event.token?.imageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={event.token.imageUrl}
            alt={tokenName}
            loading="lazy"
            className="h-full w-full object-cover"
            style={{ imageRendering: "pixelated" }}
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-[10px] text-[#64748B]">
            #{event.tokenId}
          </div>
        )}
      </a>

      <div className="min-w-0" style={{ fontFamily: "var(--font-departure)" }}>
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className={`rounded-md border px-2 py-1 text-[10px] font-bold ${tone}`}>
            {label}
          </span>
          <a
            href={getTokenExplorerUrl(PIXEL_NFT_CONTRACT_ADDRESS, event.tokenId)}
            target="_blank"
            rel="noopener noreferrer"
            className="min-w-0 truncate text-sm font-bold text-white transition-colors hover:text-[#AAAADD] sm:text-base"
          >
            {tokenName}
          </a>
          <span className="text-xs text-[#64748B]">#{event.tokenId}</span>
        </div>
        <p className="mt-1 truncate text-[11px] text-[#94A3B8] sm:text-xs">
          {actorText}
        </p>
      </div>

      <div className="col-span-2 grid grid-cols-2 items-end gap-3 sm:col-span-1 sm:block sm:text-right" style={{ fontFamily: "var(--font-departure)" }}>
        <div>
          <p className="text-[10px] uppercase tracking-wider text-[#64748B]">Price</p>
          <p className="mt-0.5 text-xs font-bold text-white sm:text-sm">
            {formatActivityPrice(event.price)}
          </p>
        </div>
        <div className="text-right">
          <p className="text-[10px] uppercase tracking-wider text-[#64748B]">
            {formatActivityTime(event.timestamp)}
          </p>
          {hasTxHash ? (
            <a
              href={getMarketplaceTxUrl(event.txHash)}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-1 inline-flex items-center justify-end gap-1 text-[11px] font-bold text-[#8888ff] transition-colors hover:text-[#AAAADD]"
            >
              Tx
              <svg width="11" height="11" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                <path d="M15 3h6v6" />
                <path d="M10 14L21 3" />
                <path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6" />
              </svg>
            </a>
          ) : (
            <span className="mt-1 inline-block text-[11px] font-bold text-[#64748B]">Mint</span>
          )}
        </div>
      </div>
    </article>
  );
}

function ActivitySkeleton() {
  return (
    <div className="divide-y divide-[#2D2D44]">
      {Array.from({ length: 6 }).map((_, index) => (
        <div key={index} className="grid grid-cols-[44px_minmax(0,1fr)] gap-3 p-3 sm:grid-cols-[56px_minmax(0,1fr)_96px] sm:gap-4 sm:p-4">
          <div className="h-11 w-11 animate-pulse rounded-lg bg-white/5 sm:h-14 sm:w-14" />
          <div className="min-w-0 space-y-2">
            <div className="h-4 w-3/4 animate-pulse rounded bg-white/5" />
            <div className="h-3 w-1/2 animate-pulse rounded bg-white/5" />
          </div>
          <div className="col-span-2 h-4 w-28 animate-pulse rounded bg-white/5 sm:col-span-1 sm:justify-self-end" />
        </div>
      ))}
    </div>
  );
}

function ActivityEmpty() {
  return (
    <div className="p-8 text-center" style={{ fontFamily: "var(--font-departure)" }}>
      <p className="text-sm font-bold text-white">No activity yet</p>
      <p className="mt-1 text-xs text-[#64748B]">History will appear after the next marketplace event.</p>
    </div>
  );
}

function ListingCard({
  listing,
  userAddress,
  meta,
  onActionComplete,
}: {
  listing: RawListing;
  userAddress: `0x${string}` | undefined;
  meta: TokenMetadata | null;
  onActionComplete: () => void;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState<"buy" | "cancel" | null>(null);
  const { address, isConnected, chainId } = useAccount();
  const { switchChain, isPending: isSwitchingChain } = useSwitchChain();
  const publicClient = usePublicClient();
  const handledTxRef = useRef<`0x${string}` | null>(null);

  const priceEth = formatEther(listing.price);
  const isOwner = userAddress && listing.seller.toLowerCase() === userAddress.toLowerCase();

  const { writeContractAsync, data: txHash } = useWriteContract();
  const {
    data: receipt,
    error: receiptError,
    isError: isReceiptError,
    isLoading: isConfirming,
    isSuccess: isConfirmed,
  } =
    useWaitForTransactionReceipt({ hash: txHash });

  useEffect(() => {
    if (!isConfirmed || !txHash || !receipt || handledTxRef.current === txHash) return;
    handledTxRef.current = txHash;

    if (receipt.status !== "success") {
      toast.error("Transaction failed", "The transaction was reverted onchain.");
      setBusy(null);
      onActionComplete();
      return;
    }

    const action = busy === "buy" ? "Purchase" : "Cancelled";
    toast.show({
      title: `${action} successful`,
      description: `${meta?.name || `Token #${listing.tokenId}`}`,
      href: getMarketplaceTxUrl(txHash),
      hrefLabel: "View on Explorer",
    });
    setBusy(null);
    onActionComplete();
  }, [isConfirmed, txHash, receipt, busy, listing.tokenId, meta, toast, onActionComplete]);

  useEffect(() => {
    if (!isReceiptError || !receiptError || !busy) return;
    toast.handleError(receiptError, "Transaction failed");
    setBusy(null);
  }, [busy, isReceiptError, receiptError, toast]);

  const handleBuy = useCallback(async () => {
    if (!isConnected || !address) {
      toast.warning("Connect wallet", "Connect your wallet before buying.");
      return;
    }
    if (chainId && chainId !== LITVM_CHAIN_ID) {
      toast.info("Wrong network", "Switching to LitVM...");
      switchChain?.({ chainId: LITVM_CHAIN_ID });
      return;
    }
    if (!publicClient) {
      toast.error("RPC unavailable", "Please refresh and try again.");
      return;
    }

    try {
      setBusy("buy");
      const currentListing = await publicClient.readContract({
        address: PIXEL_MARKETPLACE_ADDRESS,
        abi: MarketplaceAbi,
        functionName: "listings",
        args: [listing.listingId],
      }) as readonly [`0x${string}`, bigint, bigint, `0x${string}`, boolean];

      const [, , currentPrice, currentSeller, active] = currentListing;
      if (!active) {
        toast.error("Listing inactive", "This NFT was already bought or cancelled.");
        setBusy(null);
        onActionComplete();
        return;
      }
      if (currentSeller.toLowerCase() === address.toLowerCase()) {
        toast.error("Seller cannot buy", "You own this listing.");
        setBusy(null);
        return;
      }
      if (currentPrice !== listing.price) {
        toast.error("Price changed", "Refreshing the listing price.");
        setBusy(null);
        onActionComplete();
        return;
      }

      await publicClient.simulateContract({
        account: address,
        address: PIXEL_MARKETPLACE_ADDRESS,
        abi: MarketplaceAbi,
        functionName: "buy",
        args: [listing.listingId],
        value: currentPrice,
      });

      const hash = await writeContractAsync({
        address: PIXEL_MARKETPLACE_ADDRESS,
        abi: MarketplaceAbi,
        functionName: "buy",
        args: [listing.listingId],
        value: currentPrice,
      });
      toast.show({
        title: "Purchase submitted",
        description: "Waiting for confirmation...",
        href: getMarketplaceTxUrl(hash),
        hrefLabel: "View on Explorer",
      });
    } catch (err) {
      toast.handleError(err, "Purchase failed");
      setBusy(null);
    }
  }, [
    address,
    chainId,
    isConnected,
    listing.listingId,
    listing.price,
    onActionComplete,
    publicClient,
    switchChain,
    toast,
    writeContractAsync,
  ]);

  const handleCancel = useCallback(async () => {
    try {
      setBusy("cancel");
      const hash = await writeContractAsync({
        address: PIXEL_MARKETPLACE_ADDRESS,
        abi: MarketplaceAbi,
        functionName: "cancelListing",
        args: [listing.listingId],
      });
      toast.show({
        title: "Cancellation submitted",
        description: "Waiting for confirmation...",
        href: getMarketplaceTxUrl(hash),
        hrefLabel: "View on Explorer",
      });
    } catch (err) {
      toast.handleError(err, "Cancel failed");
      setBusy(null);
    }
  }, [listing.listingId, writeContractAsync, toast]);

  return (
    <div className="bg-[#1A1A2E] rounded-xl sm:rounded-2xl border border-[#2D2D44] overflow-hidden hover:border-[#8888ff]/40 transition-all hover:shadow-lg hover:shadow-[#8888ff]/10">
      <a
        href={getTokenExplorerUrl(listing.collection, listing.tokenId)}
        target="_blank"
        rel="noopener noreferrer"
        className="block aspect-square bg-gradient-to-br from-[#1A1A2E] to-[#0F0F23] relative overflow-hidden"
      >
        {meta?.imageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={meta.imageUrl}
            alt={meta.name}
            loading="lazy"
            className="w-full h-full object-cover transition-transform hover:scale-105"
            style={{ imageRendering: "pixelated" }}
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center">
            <div className="w-12 h-12 border-2 border-[#2D2D44] border-t-[#8888ff] rounded-full animate-spin" />
          </div>
        )}
        <div className="absolute top-2 left-2 px-2 py-1 rounded-md bg-black/60 backdrop-blur text-[10px] font-bold text-white">
          #{listing.tokenId.toString()}
        </div>
      </a>

      <div className="p-3 sm:p-4 space-y-2.5 sm:space-y-3" style={{ fontFamily: "var(--font-departure)" }}>
        <div>
          <h3 className="text-white font-bold text-xs sm:text-sm truncate">
            {meta?.name || `Token #${listing.tokenId.toString()}`}
          </h3>
          <p className="text-[#64748B] text-[10px] sm:text-[11px] mt-0.5 truncate">
            Seller: {shortenAddress(listing.seller)}
          </p>
        </div>

        <div className="flex items-baseline justify-between">
          <div>
            <p className="text-[#64748B] text-[10px] uppercase tracking-wider">Price</p>
            <p className="text-white font-bold text-sm sm:text-lg break-all">{priceEth} zkLTC</p>
          </div>
        </div>

        {isOwner ? (
          <button
            onClick={handleCancel}
            disabled={busy !== null || isConfirming}
            className="min-h-11 w-full py-3 sm:py-2.5 rounded-lg bg-red-500/20 border border-red-500/40 text-red-300 text-[10px] sm:text-xs font-bold hover:bg-red-500/30 transition-colors disabled:opacity-50"
          >
            {busy === "cancel" || isConfirming ? "Cancelling..." : "Cancel Listing"}
          </button>
        ) : (
          <button
            onClick={handleBuy}
            disabled={busy !== null || isConfirming || isSwitchingChain}
            className="min-h-11 w-full py-3 sm:py-2.5 rounded-lg bg-[#8888ff] hover:bg-[#AAAADD] text-white text-[10px] sm:text-xs font-bold transition-colors disabled:opacity-50"
          >
            {isSwitchingChain ? "Switching..." : busy === "buy" || isConfirming ? "Buying..." : "Buy Now"}
          </button>
        )}
      </div>
    </div>
  );
}

function appendUniqueEvents(
  current: MarketActivityEvent[],
  incoming: MarketActivityEvent[]
): MarketActivityEvent[] {
  const seen = new Set(current.map((event) => event.id));
  const next = [...current];
  for (const event of incoming) {
    if (seen.has(event.id)) continue;
    seen.add(event.id);
    next.push(event);
  }
  return next;
}

function activityFilterToType(filter: ActivityFilter): MarketActivityType | null {
  if (filter === "sold") return "BOUGHT";
  if (filter === "minted") return "MINTED";
  if (filter === "listed") return "LISTED";
  if (filter === "cancelled") return "CANCELLED";
  return null;
}

function activityLabel(type: MarketActivityType): string {
  if (type === "MINTED") return "Minted";
  if (type === "BOUGHT") return "Sold";
  if (type === "CANCELLED") return "Cancelled";
  return "Listed";
}

function activityTone(type: MarketActivityType): string {
  if (type === "MINTED") {
    return "border-yellow-300/40 bg-yellow-300/10 text-yellow-200";
  }
  if (type === "BOUGHT") {
    return "border-emerald-400/30 bg-emerald-400/10 text-emerald-300";
  }
  if (type === "CANCELLED") {
    return "border-red-400/30 bg-red-400/10 text-red-300";
  }
  return "border-[#8888ff]/30 bg-[#8888ff]/10 text-[#AAAADD]";
}

function activityActorText(event: MarketActivityEvent): string {
  const seller = event.seller ? shortenAddress(event.seller) : "unknown seller";
  const buyer = event.buyer ? shortenAddress(event.buyer) : "unknown buyer";
  if (event.eventType === "MINTED") return `Minted by ${seller}`;
  if (event.eventType === "BOUGHT") return `Buyer ${buyer} · Seller ${seller}`;
  if (event.eventType === "CANCELLED") return `Cancelled by ${seller}`;
  return `Listed by ${seller}`;
}

function formatActivityPrice(price: string | null): string {
  if (!price) return "-";
  try {
    const value = formatEther(BigInt(price));
    const [whole, fraction = ""] = value.split(".");
    const trimmed = fraction.replace(/0+$/, "");
    const compact = trimmed ? `${whole}.${trimmed.slice(0, 6)}` : whole;
    return `${compact} zkLTC`;
  } catch {
    return "-";
  }
}

function formatActivityTime(timestamp: number): string {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return "Unknown";
  const ms = timestamp * 1000;
  const diffMs = Date.now() - ms;
  if (diffMs < 60_000) return "Just now";
  if (diffMs < 3_600_000) return `${Math.floor(diffMs / 60_000)}m ago`;
  if (diffMs < 86_400_000) return `${Math.floor(diffMs / 3_600_000)}h ago`;
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(ms));
}
