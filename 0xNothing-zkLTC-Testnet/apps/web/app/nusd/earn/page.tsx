import type { Metadata } from "next";
import { RevenuePanel } from "@fi/components/RevenuePanel";
import { RewardsDashboard } from "@fi/components/RewardsDashboard";
import { PageHeading } from "@fi/components/UiStates";

export const metadata: Metadata = {
  title: "Earn",
  description: "Stake NUSD for 0xPoints and a share of each 10,000 NUSD reward round.",
};

export default function NusdEarnPage() {
  return (
    <div className="fi-page">
      <PageHeading title="Earn" description="Stake NUSD for 0xPoints and a share of each 10,000 NUSD reward round." />
      <RewardsDashboard />
      <RevenuePanel />
    </div>
  );
}
