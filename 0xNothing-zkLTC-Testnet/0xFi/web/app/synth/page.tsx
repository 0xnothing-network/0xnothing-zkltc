import { OracleFeedTable } from "@/components/OracleFeedTable";
import { SynthWorkspace } from "@/components/SynthWorkspace";
import { PageHeading } from "@/components/UiStates";

export default function SynthPage() {
  return <div className="fi-page"><PageHeading title="SYNTH" /><SynthWorkspace /><OracleFeedTable /></div>;
}
