import { FarmDashboard } from "@fi/components/FarmDashboard";
import { PageHeading } from "@fi/components/UiStates";

export default async function FarmPage({
  searchParams,
}: {
  searchParams: Promise<{ pair?: string | string[] }>;
}) {
  const query = await searchParams;
  const initialPair = typeof query.pair === "string" ? query.pair : undefined;

  return (
    <div className="fi-page">
      <PageHeading title="Earn" />
      <FarmDashboard initialPair={initialPair} />
    </div>
  );
}
