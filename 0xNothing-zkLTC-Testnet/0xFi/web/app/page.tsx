import type { Metadata } from "next";
import { PoolDirectory } from "@/components/PoolDirectory";

export const metadata: Metadata = {
  title: "Trade",
  description: "Choose a live 0xFi market to trade on LitVM.",
};

export default function TradePage() {
  return (
    <div className="fi-page fi-markets-page">
      <PoolDirectory tradeOnly />
    </div>
  );
}
