"use client";

import Image from "next/image";
import { useRef, useState } from "react";
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowUpRight, ArrowsClockwise } from "@phosphor-icons/react";
import { formatUnits } from "viem";
import { fetchJson } from "@/lib/http";
import { getMarketplaceTxUrl, getTokenExplorerUrl, shortenAddress } from "@/lib/contract";
import { getPixelImageUrl } from "@/lib/pixelImage";
import { NUSD_MARKETPLACE_ADDRESS } from "@/lib/nusdMarketplaceConfig";
import type { NusdActivityFilter, NusdActivityPage, NusdActivityEvent } from "@/lib/nusdMarketplaceActivity";
import styles from "./NusdMarketplaceDashboard.module.css";

const filters: { value: NusdActivityFilter; label: string }[] = [
  { value: "ALL", label: "All" }, { value: "BOUGHT", label: "Sold" }, { value: "MINTED", label: "Minted" },
  { value: "LISTED", label: "Listed" }, { value: "CANCELLED", label: "Cancelled" }, { value: "OFFERS", label: "Offers" },
];
const labels: Record<NusdActivityEvent["type"], string> = {
  MINTED: "Minted", LISTED: "Listed", UPDATED: "Price updated", BOUGHT: "Sold", CANCELLED: "Cancelled", OFFER_CREATED: "Offer placed", OFFER_REFUNDED: "Offer refunded",
};

export function NusdMarketplaceActivity() {
  const [filter, setFilter] = useState<NusdActivityFilter>("ALL");
  const moreLock = useRef(false);
  const queryClient = useQueryClient();
  const queryKey = ["pixel-nusd-activity", NUSD_MARKETPLACE_ADDRESS, filter];
  const activity = useInfiniteQuery({
    queryKey, initialPageParam: "",
    queryFn: ({ pageParam, signal }) => fetchJson<NusdActivityPage>(`/api/marketplace/activity?type=${filter}&limit=24${pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ""}`, { signal }),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    enabled: Boolean(NUSD_MARKETPLACE_ADDRESS), staleTime: 5_000,
    refetchInterval: (query) => (query.state.data?.pages.length ?? 0) > 1 ? false : 10_000,
    retry: 1, maxPages: 20,
  });
  const seen = new Set<string>();
  const events = activity.data?.pages.flatMap((page) => page.events).filter((event) => {
    if (seen.has(event.id)) return false;
    seen.add(event.id);
    return true;
  }) ?? [];
  async function loadMore() {
    if (moreLock.current || activity.isFetching || !activity.hasNextPage) return;
    moreLock.current = true;
    try { await activity.fetchNextPage(); }
    finally { moreLock.current = false; }
  }

  return <section id="market-activity" className={styles.activitySection} aria-labelledby="nusd-activity-title" aria-busy={activity.isFetching}>
    <div className={styles.sectionHeading}><div><span className={styles.eyebrow}>NFT history</span><h2 id="nusd-activity-title">Recent marketplace activity</h2></div><button className={styles.iconButton} aria-label="Refresh activity" disabled={activity.isFetching} onClick={() => void activity.refetch()}><ArrowsClockwise size={18} className={activity.isFetching ? styles.spinning : undefined} aria-hidden="true" /></button></div>
    <div className={styles.activityToolbar}><div className={styles.toggleGroup} role="group" aria-label="Filter marketplace activity">{filters.map((item) => <button key={item.value} aria-pressed={filter === item.value} onClick={() => setFilter(item.value)}>{item.label}</button>)}</div>{(activity.data?.pages.length ?? 0) > 1 && <button className={styles.textButton} onClick={() => void queryClient.resetQueries({ queryKey })}>Back to latest</button>}</div>
    {activity.isError && <div className={styles.error} role="alert"><p>Unable to load NUSD marketplace history.</p><button className={styles.secondaryButton} disabled={activity.isFetching} onClick={() => void activity.refetch()}>Retry</button></div>}
    {!activity.data && activity.isPending ? <div className={styles.activityLoading} role="status">Loading on-chain activity…</div>
      : events.length === 0 ? <div className={styles.emptyOffers}><div><h3>No activity for this filter yet.</h3><p>This feed shows NFT mints and NUSD marketplace events since this market launched.</p></div></div>
      : <div className={styles.activityList}>{events.map((event) => <article className={styles.activityRow} key={event.id}>
          <a className={styles.thumbnail} href={getTokenExplorerUrl(event.collection, event.tokenId)} target="_blank" rel="noopener noreferrer" aria-label={`View NFT #${event.tokenId}`}><Image src={getPixelImageUrl(event.tokenId, event.collection)} alt={`0xPixel #${event.tokenId}`} width={56} height={56} unoptimized className={styles.artImage} /></a>
          <div className={styles.activityInfo}><span className={styles.activityBadge} data-kind={event.type}>{labels[event.type]}</span><a href={getTokenExplorerUrl(event.collection, event.tokenId)} target="_blank" rel="noopener noreferrer">NFT #{event.tokenId}</a><p>{shortenAddress(event.collection)} · {shortenAddress(event.actor)}{event.other ? ` → ${shortenAddress(event.other)}` : ""}</p></div>
          <div className={styles.activityValue}><strong>{event.price === null ? "—" : `${formatUnits(BigInt(event.price), 18)} NUSD`}</strong><time dateTime={new Date(Number(event.timestamp) * 1000).toISOString()}>{new Date(Number(event.timestamp) * 1000).toLocaleString("en-US")}</time><a href={getMarketplaceTxUrl(event.transactionHash)} target="_blank" rel="noopener noreferrer">View transaction<ArrowUpRight size={13} aria-hidden="true" /></a></div>
        </article>)}</div>}
    {activity.hasNextPage && <div className={styles.activityPagination}><button className={styles.secondaryButton} disabled={activity.isFetching} onClick={() => void loadMore()}>{activity.isFetchingNextPage ? "Loading…" : "Load more activity"}</button><p className={styles.small}>Earlier blocks are read in bounded pages; empty pages can still have older history.</p></div>}
  </section>;
}
