import type { Metadata } from "next";
import { PumpDiscover } from "@/features/pump/components/PumpDiscover";

export const metadata: Metadata = {
  title: "0xPump | NUSD token launchpad",
  description: "Create and trade NUSD bonding-curve tokens with a $6,000 READY market-cap target on LitVM Testnet.",
};

export default function PumpPage() {
  return <PumpDiscover />;
}
