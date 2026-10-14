import { FarmDashboard } from "@fi/components/FarmDashboard";
import { RevenuePanel } from "@fi/components/RevenuePanel";
import { RewardsDashboard } from "@fi/components/RewardsDashboard";
import { PageHeading } from "@fi/components/UiStates";

export default async function EarnPage({
  searchParams,
}: {
  searchParams: Promise<{ pair?: string | string[] }>;
}) {
  const query = await searchParams;
  const initialPair = typeof query.pair === "string" ? query.pair : undefined;
  return (
    <div className="fi-page">
      <PageHeading title="Earn" description="Stake NUSD for 0xPoints and a share of each 10,000 NUSD reward round, or farm LP rewards." />
      <RewardsDashboard />
      <RevenuePanel />
      <FarmDashboard initialPair={initialPair} />
    </div>
  );
}
