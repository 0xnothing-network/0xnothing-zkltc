import type { Metadata } from "next";
import { PumpPortfolio } from "@/features/pump/components/PumpPortfolio";

export const metadata: Metadata = {
  title: "Portfolio | 0xPump",
  description: "View 0xPump holdings and created markets.",
};

export default function PumpPortfolioPage() {
  return <PumpPortfolio />;
}
