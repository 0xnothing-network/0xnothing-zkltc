import type { Metadata } from "next";
import { FaucetPanel } from "@/features/faucet/components/FaucetPanel";

export const metadata: Metadata = {
  title: "Faucet | 0xNothing",
  description: "Claim small LiteForge zkLTC and NUSD drips for Pump and 0xFi testing.",
};

export default function FaucetPage() {
  return (
    <main className="pump-page faucet-page">
      <FaucetPanel />
    </main>
  );
}
