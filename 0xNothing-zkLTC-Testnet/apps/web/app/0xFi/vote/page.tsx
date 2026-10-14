import type { Metadata } from "next";
import { SurplusVoteDashboard } from "@fi/components/SurplusVoteDashboard";
import { PageHeading } from "@fi/components/UiStates";

export const metadata: Metadata = {
  title: "Vote",
  description: "Community vote to mint NUSD from surplus zkLTC reserve back down to 2x backing.",
};

export default function VotePage() {
  return (
    <div className="fi-page">
      <PageHeading title="Vote" description="When the zkLTC reserve reaches 3x the NUSD supply, the community decides whether to mint the surplus." />
      <SurplusVoteDashboard />
    </div>
  );
}
