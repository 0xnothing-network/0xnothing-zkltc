"use client";

import { useMemo, useState, useCallback } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { useAccount, useReadContract } from "wagmi";
import { OwnedNftCard, type OwnedNft } from "@/components/OwnedNftCard";
import { GridSkeleton } from "@/components/Skeleton";
import { PIXEL_MARKETPLACE_ADDRESS } from "@/lib/contract";
import { MarketplaceAbi } from "@/lib/marketplaceAbi";

type SortKey = "newest" | "oldest" | "name";

export default function GalleryPage() {
  const { address, isConnected } = useAccount();
  const [refreshKey, setRefreshKey] = useState(0);
  const [sort, setSort] = useState<SortKey>("newest");

  const refresh = useCallback(() => {
    setRefreshKey((k) => k + 1);
  }, []);

  const { data, isLoading, error } = useUserNfts(address, refreshKey);
  const { data: paused } = useReadContract({
    address: PIXEL_MARKETPLACE_ADDRESS,
    abi: MarketplaceAbi,
    functionName: "paused",
  });

  const sorted = useMemo<OwnedNft[]>(() => {
    if (!data) return [];
    const arr = [...data];
    switch (sort) {
      case "newest":
        arr.sort((a, b) => {
          const left = BigInt(a.tokenId);
          const right = BigInt(b.tokenId);
          return left === right ? 0 : left > right ? -1 : 1;
        });
        break;
      case "oldest":
        arr.sort((a, b) => {
          const left = BigInt(a.tokenId);
          const right = BigInt(b.tokenId);
          return left === right ? 0 : left < right ? -1 : 1;
        });
        break;
      case "name":
        arr.sort((a, b) => a.name.localeCompare(b.name));
        break;
    }
    return arr;
  }, [data, sort]);

  return (
    <div className="min-h-[calc(100vh-64px)] px-3 py-6 sm:px-5 sm:py-10 max-w-7xl mx-auto" style={{ fontFamily: "var(--font-departure)" }}>
      <div className="mb-6 sm:mb-10 flex items-end justify-between flex-wrap gap-4">
        <div>
          <h1
            className="hero-fade-in text-2xl sm:text-4xl font-bold text-white mb-2"
            style={{ fontFamily: "var(--font-departure)" }}
          >
            MY GALLERY
          </h1>
          <p
            className="hero-fade-in-delay text-[#94A3B8] text-sm"
            style={{ fontFamily: "var(--font-departure)" }}
          >
            Your 0xPIXEL collection
          </p>
        </div>
        <Link
          href="/0xpixel"
          className="animate-fadeInUp-delay-2 pixel-btn pixel-btn-indigo"
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 8,
            width: "fit-content",
          }}
        >
          + NEW PIXEL ART
        </Link>
      </div>

      {paused === true ? (
        <div
          className="mb-4 px-4 py-3 rounded-lg bg-amber-500/10 border border-amber-500/30 text-amber-300 text-sm"
          style={{ fontFamily: "var(--font-departure)" }}
        >
          Marketplace is paused. Listing and delisting are temporarily disabled.
        </div>
      ) : null}

      {error && data ? (
        <div className="mb-4 flex items-center justify-between gap-3 border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300" role="alert">
          <span>Could not refresh the gallery. The items below may be out of date.</span>
          <button type="button" onClick={refresh} className="pixel-btn pixel-btn-secondary pixel-btn-sm shrink-0">
            Retry
          </button>
        </div>
      ) : null}

      {!isConnected ? (
        <NotConnected />
      ) : error && !data ? (
        <ErrorState message={(error as Error).message} onRetry={refresh} />
      ) : isLoading ? (
        <GridSkeleton count={6} />
      ) : sorted.length === 0 ? (
        <EmptyState />
      ) : (
        <>
          <div className="flex items-center justify-between mb-4 sm:mb-6 flex-wrap gap-3">
            <div
              className="text-sm text-[#94A3B8]"
              style={{ fontFamily: "var(--font-departure)" }}
            >
              {sorted.length} {sorted.length === 1 ? "pixel" : "pixels"}
            </div>
            <select
              value={sort}
              onChange={(e) => setSort(e.target.value as SortKey)}
              className="bg-[#0F0F23] border border-[#2D2D44] text-white text-sm rounded-lg px-3 py-2.5 sm:px-4 sm:py-2 focus:outline-none focus:border-indigo-500 transition-colors cursor-pointer"
              style={{ fontFamily: "var(--font-departure)" }}
            >
              <option value="newest">Newest</option>
              <option value="oldest">Oldest</option>
              <option value="name">Name</option>
            </select>
          </div>
          <div
            className="nft-grid grid grid-cols-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3 sm:gap-6"
          >
            {sorted.map((nft, index) => (
              <div key={nft.tokenId.toString()}>
                <OwnedNftCard
                  nft={nft}
                  isPaused={paused === true}
                  onChanged={refresh}
                  priority={index < 4}
                />
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function NotConnected() {
  return (
    <div className="animate-fadeInUp text-center py-20">
      <h2
        className="text-xl font-bold text-white mb-2"
        style={{ fontFamily: "var(--font-departure)" }}
      >
        Connect Your Wallet
      </h2>
      <p
        className="text-[#94A3B8] max-w-sm mx-auto"
        style={{ fontFamily: "var(--font-departure)" }}
      >
        Connect a wallet to view your 0xPIXEL collection
      </p>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="animate-fadeInUp text-center py-20">
      <div className="w-24 h-24 mx-auto mb-6 bg-[#1A1A2E] rounded-2xl flex items-center justify-center border border-[#2D2D44]">
        <svg
          width="48"
          height="48"
          viewBox="0 0 24 24"
          fill="none"
          stroke="#6366F1"
          strokeWidth="1.5"
        >
          <path d="M3 3h18v18H3z" />
          <path d="M12 8v8M8 12h8" />
        </svg>
      </div>
      <h2
        className="text-xl font-bold text-white mb-2"
        style={{ fontFamily: "var(--font-departure)" }}
      >
        No Pixels Yet
      </h2>
      <p
        className="text-[#94A3B8] max-w-sm mx-auto mb-8"
        style={{ fontFamily: "var(--font-departure)" }}
      >
        Mint your first pixel art NFT
      </p>
      <Link
        href="/0xpixel"
        className="pixel-btn pixel-btn-indigo"
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 8,
          padding: "12px 24px",
        }}
      >
        START DRAWING
      </Link>
    </div>
  );
}

function ErrorState({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  return (
    <div
      className="animate-fadeInUp text-center py-16 bg-[#1A1A2E] border border-red-500/30 rounded-2xl"
    >
      <p
        className="text-red-300 mb-4"
        style={{ fontFamily: "var(--font-departure)" }}
      >
        Failed to load gallery: {message}
      </p>
      <button
        onClick={onRetry}
        className="pixel-btn pixel-btn-secondary"
      >
        Retry
      </button>
    </div>
  );
}

function useUserNfts(address: `0x${string}` | undefined, refreshKey: number) {
  return useQuery<OwnedNft[], Error>({
    queryKey: ["pixel-user-nfts", address, refreshKey],
    enabled: Boolean(address),
    staleTime: 15_000,
    placeholderData: (previousData, previousQuery) =>
      previousQuery?.queryKey[1] === address ? previousData : undefined,
    queryFn: async ({ signal }) => {
      if (!address) return [];
      const params = new URLSearchParams({ address });
      if (refreshKey > 0) params.set("force", "1");
      const response = await fetch(`/api/user-nfts?${params.toString()}`, {
        signal,
        cache: refreshKey > 0 ? "no-store" : "default",
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error || `HTTP ${response.status}`);
      }
      const body = (await response.json()) as { tokens: OwnedNftApiShape[] };
      return body.tokens.map<OwnedNft>((token) => ({
        tokenId: BigInt(token.tokenId),
        name: token.name,
        imageUrl: token.imageUrl,
        listing: token.listing
          ? {
              listingId: BigInt(token.listing.listingId),
              price: BigInt(token.listing.price),
            }
          : null,
      }));
    },
  });
}

interface OwnedNftApiShape {
  tokenId: string;
  name: string;
  imageUrl: string;
  listing: { listingId: string; price: string } | null;
}
