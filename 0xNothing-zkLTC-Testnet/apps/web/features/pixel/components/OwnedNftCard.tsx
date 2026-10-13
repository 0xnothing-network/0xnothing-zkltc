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

export const OwnedNftCard = memo(function OwnedNftCard({ nft, priority = false }: CardProps) {
  return <article className="nft-card group bg-[#1A1A2E] rounded-xl sm:rounded-2xl overflow-hidden border border-[#2D2D44] hover:border-indigo-500/50 transition-[border-color,box-shadow,transform] duration-300">
    <Link href={getTokenExplorerUrl(nft.collection, nft.tokenId)} target="_blank" rel="noopener noreferrer" className="block relative aspect-square bg-[#0F0F23] flex items-center justify-center overflow-hidden">
      <Image src={nft.imageUrl || getPixelImageUrl(nft.tokenId, nft.collection)} alt={nft.name || `NFT #${nft.tokenId}`} width={512} height={512} unoptimized className="w-full h-full object-contain" style={{ imageRendering: "pixelated" }} loading={priority ? "eager" : "lazy"} />
      {nft.listing && <span className="absolute top-2 left-2 px-2 py-1 bg-emerald-500/20 border border-emerald-500/40 text-emerald-300 text-[10px] max-w-[calc(100%-16px)] truncate">LISTED · {formatUnits(nft.listing.price, 18)} NUSD</span>}
    </Link>
    <div className="p-3 sm:p-4 space-y-3">
      <div><p className="text-[10px] text-[#94A3B8] tracking-wider">0xPIXEL</p><h3 className="text-white font-bold text-sm sm:text-base truncate">{nft.name || "Untitled"}</h3><p className="text-[10px] text-[#94A3B8]">#{nft.tokenId.toString()}</p></div>
      <Link href={`/0xpixel/marketplace?collection=${nft.collection}&tokenId=${nft.tokenId}#sell-nusd`} className="pixel-btn pixel-btn-emerald pixel-btn-sm w-full">{nft.listing ? "MANAGE NUSD LISTING" : "SELL FOR NUSD"}</Link>
    </div>
  </article>;
});
