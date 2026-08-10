import { LegacySynthRecovery } from "@fi/components/LegacySynthRecovery";
import { OracleFeedTable } from "@fi/components/OracleFeedTable";
import { SynthWorkspace } from "@fi/components/SynthWorkspace";
import { PageHeading } from "@fi/components/UiStates";

export default function SynthPage() {
  return (
    <div className="fi-page">
      <PageHeading title="Synth" />
      <SynthWorkspace />
      <LegacySynthRecovery />
      <OracleFeedTable />
    </div>
  );
}
