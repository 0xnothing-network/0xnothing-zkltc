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
      <PageHeading title="Farm" description="Stake LP tokens in a pool's gauge to earn its farm rewards." />
      <FarmDashboard initialPair={initialPair} />
    </div>
  );
}
