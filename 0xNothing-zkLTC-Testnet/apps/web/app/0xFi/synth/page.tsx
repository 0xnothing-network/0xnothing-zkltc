import { LegacySynthRecovery } from "@fi/components/LegacySynthRecovery";
import { OracleFeedTable } from "@fi/components/OracleFeedTable";
import { SynthWorkspace } from "@fi/components/SynthWorkspace";
import { PageHeading } from "@fi/components/UiStates";

export default async function SynthPage({
  searchParams,
}: {
  searchParams: Promise<{ asset?: string | string[] }>;
}) {
  const query = await searchParams;
  const initialSynth = query.asset === "nETH" ? "nETH" : "nBTC";

  return (
    <div className="fi-page">
      <PageHeading title="Synth" />
      <SynthWorkspace initialSynth={initialSynth} />
      <LegacySynthRecovery />
      <OracleFeedTable />
    </div>
  );
}
