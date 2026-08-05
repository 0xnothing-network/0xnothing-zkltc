import { FarmDashboard } from "@/components/FarmDashboard";
import { PageHeading } from "@/components/UiStates";

export default function FarmPage() {
  return <div className="fi-page"><PageHeading title="FARM" /><FarmDashboard /></div>;
}
