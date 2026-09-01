import { EarnDashboard } from "@fi/components/EarnDashboard";
import { FarmDashboard } from "@fi/components/FarmDashboard";
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
      <PageHeading title="Earn" description="Lock NUSD for xPoints or use the remaining LP reward programs." />
      <EarnDashboard />
      <FarmDashboard initialPair={initialPair} />
    </div>
  );
}
