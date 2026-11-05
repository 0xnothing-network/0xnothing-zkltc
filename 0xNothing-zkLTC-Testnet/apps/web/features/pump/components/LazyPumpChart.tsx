"use client";

import dynamic from "next/dynamic";
import { memo } from "react";
import { PumpInlineLoading } from "@/features/pump/components/PumpStates";
import type { Address } from "viem";

const PumpChart = dynamic(
  () => import("@/features/pump/components/PumpChart").then((module) => module.PumpChart),
  {
    ssr: false,
    loading: () => (
      <section className="pump-panel pump-chart-panel" aria-busy="true" aria-label="Loading market chart">
        <PumpInlineLoading label="Loading market chart" />
      </section>
    ),
  },
);

export const LazyPumpChart = memo(function LazyPumpChart({ token, tokenName }: { token: Address; tokenName: string }) {
  return <PumpChart token={token} tokenName={tokenName} />;
});
