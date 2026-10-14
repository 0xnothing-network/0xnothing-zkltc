import type { Metadata } from "next";
import { LegacyMarketplacePanel } from "@/features/pixel/components/LegacyMarketplacePanel";

export const metadata: Metadata = {
  title: "Legacy zkLTC marketplace · cancel listings and offers",
  description: "Cancel your old zkLTC 0xPixel listings and refund escrowed offers on the retired PixelMarket.",
  alternates: { canonical: "/0xpixel/marketplace/legacy" },
  robots: { index: false },
};

export default function LegacyMarketplacePage() {
  return <LegacyMarketplacePanel />;
}
