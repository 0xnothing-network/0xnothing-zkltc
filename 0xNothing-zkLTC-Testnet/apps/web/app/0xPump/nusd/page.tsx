import type { Metadata } from "next";
import { NusdEmergencyPanel } from "@/features/pump/components/NusdEmergencyPanel";
import { NusdOraclePanel } from "@/features/pump/components/NusdOraclePanel";

export const metadata: Metadata = {
  title: "NUSD | 0xPump",
  description: "Mint and redeem NUSD directly against the zkLTC reserve.",
};

export default function NusdPage() {
  return (
    <main className="pump-page pump-nusd-page">
      <NusdOraclePanel />
      <NusdEmergencyPanel />
    </main>
  );
}
