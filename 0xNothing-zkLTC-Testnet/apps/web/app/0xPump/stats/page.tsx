import type { Metadata } from "next";
import { PumpStatsDashboard } from "@/features/pump/components/PumpStatsDashboard";

export const metadata: Metadata = {
  title: "Stats | 0xPump",
  description: "0xPump volume, protocol revenue, market activity, and developer fee management.",
};

export default function PumpStatsPage() {
  return <PumpStatsDashboard />;
}
