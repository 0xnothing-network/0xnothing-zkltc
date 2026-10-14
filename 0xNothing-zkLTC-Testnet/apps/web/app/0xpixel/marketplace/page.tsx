import type { Metadata } from "next";
import { NusdMarketplaceDashboard } from "@/features/pixel/components/NusdMarketplaceDashboard";
import { nusdNftSelection } from "@/lib/nusdMarketplace";

export const metadata: Metadata = {
  title: "NFT Marketplace · NUSD",
  description: "Trade 0xPixel NFTs, escrow offers and reuse sale proceeds in NUSD on LiteForge.",
  alternates: { canonical: "/0xpixel/marketplace" },
};

export default async function MarketplacePage({ searchParams }: { searchParams: Promise<{ collection?: string | string[]; tokenId?: string | string[] }> }) {
  const parameters = await searchParams;
  return <NusdMarketplaceDashboard initialTokenKey={nusdNftSelection(parameters.collection, parameters.tokenId)} />;
}
