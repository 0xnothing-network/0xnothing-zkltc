import { RwaDashboard } from "@fi/components/RwaDashboard";
import { PageHeading } from "@fi/components/UiStates";

export default function RwaPage() {
  return <div className="fi-page">
    <PageHeading title="Real-world assets" description="Buy and sell issuer tokens with transparent reserves and a 1% trading fee." />
    <RwaDashboard />
  </div>;
}
