import type { Metadata } from "next";
import { RevenuePanel } from "@fi/components/RevenuePanel";
import { RewardsDashboard } from "@fi/components/RewardsDashboard";
import { PageHeading } from "@fi/components/UiStates";

export const metadata: Metadata = {
  title: "Earn",
  description: "Stake NUSD for 0xPoints and a share of every protocol fee, streamed to stakers over 7 days.",
};

export default function NusdEarnPage() {
  return (
    <div className="fi-page">
      <PageHeading title="Earn" description="Stake NUSD for 0xPoints and a share of every protocol fee, streamed to stakers over 7 days." />
      <RewardsDashboard />
      <RevenuePanel />
    </div>
  );
}
