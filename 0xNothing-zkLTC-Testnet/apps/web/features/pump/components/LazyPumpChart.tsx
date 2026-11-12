"use client";

import dynamic from "next/dynamic";
import { memo } from "react";
import { PumpInlineLoading } from "@/features/pump/components/PumpStates";
import type { Address } from "viem";

const loadPumpChart = () => import("@/features/pump/components/PumpChart").then((module) => module.PumpChart);
// Next never preloads an `ssr: false` chunk, so the chart code was only requested after
// hydration and the market response. Starting it here downloads it alongside both.
if (typeof window !== "undefined") void loadPumpChart().catch(() => undefined);

const PumpChart = dynamic(
  loadPumpChart,
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
