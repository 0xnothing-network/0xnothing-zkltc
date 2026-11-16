"use client";

import { memo } from "react";
import Image from "next/image";
import Link from "next/link";
import { formatUnits } from "viem";
import { getTokenExplorerUrl } from "@/lib/contract";
import { getPixelImageUrl } from "@/lib/pixelImage";

export interface OwnedNft {
  collection: `0x${string}`;
  tokenId: bigint;
  name: string;
  imageUrl: string;
  listing: { listingId: bigint; price: bigint } | null;
}

interface CardProps {
  nft: OwnedNft;
  priority?: boolean;
}

// Display only: en-US grouping, every decimal kept.
function nusdPrice(value: bigint) {
  const [whole, fraction] = formatUnits(value, 18).split(".");
  return `${BigInt(whole).toLocaleString("en-US")}${fraction ? `.${fraction}` : ""}`;
}

// Same anatomy as the marketplace listing card: name, one muted meta line, then the action.
export const OwnedNftCard = memo(function OwnedNftCard({ nft, priority = false }: CardProps) {
  return <article className="nft-card group bg-(--surface-1) rounded-xl sm:rounded-2xl overflow-hidden border border-(--line)">
    <Link href={getTokenExplorerUrl(nft.collection, nft.tokenId)} target="_blank" rel="noopener noreferrer" className="block relative aspect-square bg-(--surface-2) flex items-center justify-center overflow-hidden">
      <Image src={nft.imageUrl || getPixelImageUrl(nft.tokenId, nft.collection)} alt={nft.name || `NFT #${nft.tokenId}`} width={512} height={512} unoptimized className="w-full h-full object-contain" style={{ imageRendering: "pixelated" }} loading={priority ? "eager" : "lazy"} />
    </Link>
    <div className="p-3 sm:p-4 space-y-3">
      <div className="min-w-0">
        <h3 className="text-(--text-1) font-bold text-sm sm:text-base truncate">{nft.name || "Untitled"}</h3>
        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-(--text-2)">
          <span className="min-w-0 truncate">0xPixel NFT · #{nft.tokenId.toString()}</span>
          {nft.listing && <span className="ml-auto max-w-full truncate rounded-[4px] border border-(--positive)/35 px-1.5 py-0.5 text-xs font-medium text-(--positive)">LISTED · {nusdPrice(nft.listing.price)} NUSD</span>}
        </div>
      </div>
      <Link href={`/0xpixel/marketplace?collection=${nft.collection}&tokenId=${nft.tokenId}#sell-nusd`} className="pixel-btn pixel-btn-emerald pixel-btn-sm w-full">{nft.listing ? "MANAGE NUSD LISTING" : "SELL FOR NUSD"}</Link>
    </div>
  </article>;
});
