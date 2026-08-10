"use client";

import dynamic from "next/dynamic";
import { SkeletonRows } from "@fi/components/UiStates";

type LazyMarketChartProps = {
  pair: string;
  label?: string;
  token0?: { symbol: string; imageUrl?: string };
  token1?: { symbol: string; imageUrl?: string };
};

const MarketChart = dynamic(
  () => import("@fi/components/MarketChart").then((module) => module.MarketChart),
  {
    ssr: false,
    loading: () => (
      <section className="fi-panel fi-panel-flush fi-chart-panel" aria-busy="true" aria-label="Loading market chart">
        <div className="fi-chart-heading">
          <div className="fi-chart-market"><h2>Market chart</h2></div>
        </div>
        <div className="fi-chart-frame">
          <div className="fi-chart-overlay"><SkeletonRows count={4} label="Loading price chart" /></div>
        </div>
      </section>
    ),
  },
);

export function LazyMarketChart(props: LazyMarketChartProps) {
  return <MarketChart {...props} />;
}
