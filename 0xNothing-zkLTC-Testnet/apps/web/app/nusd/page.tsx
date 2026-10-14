import type { Metadata } from "next";
import { PageHeading } from "@fi/components/UiStates";
import { NusdEmergencyPanel } from "@/features/pump/components/NusdEmergencyPanel";
import { NusdOraclePanel } from "@/features/pump/components/NusdOraclePanel";

export const metadata: Metadata = {
  title: { absolute: "NUSD | 0xNothing" },
  description: "Mint and redeem NUSD directly against the zkLTC reserve.",
};

export default function NusdMintPage() {
  return (
    <div className="fi-page">
      <PageHeading title="Mint" description="Mint NUSD with zkLTC or redeem it back at the DIA price, with no protocol fee." />
      <div className="pump-shell nusd-mint">
        <NusdOraclePanel />
        <NusdEmergencyPanel />
      </div>
    </div>
  );
}
