import { FarmDashboard } from "@fi/components/FarmDashboard";
import { PageHeading } from "@fi/components/UiStates";

export default function FarmPage() {
  return (
    <div className="fi-page">
      <PageHeading title="Earn" />
      <FarmDashboard />
    </div>
  );
}
