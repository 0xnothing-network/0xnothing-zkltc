import type { Metadata } from "next";
import { SwapDashboard } from "@fi/components/SwapDashboard";

export const metadata: Metadata = {
  title: "Swap | 0xFi",
  description: "Swap assets through 0xFi liquidity on LitVM.",
};

export default function SwapPage() {
  return <SwapDashboard />;
}
