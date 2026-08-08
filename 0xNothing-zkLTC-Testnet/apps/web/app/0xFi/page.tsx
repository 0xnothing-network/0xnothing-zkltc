import type { Metadata } from "next";
import { SwapDashboard } from "@fi/components/SwapDashboard";

export const metadata: Metadata = {
  title: "Trade",
  description: "Mint, redeem, and swap assets through 0xFi on LitVM.",
};

export default function TradePage() {
  return <SwapDashboard />;
}
