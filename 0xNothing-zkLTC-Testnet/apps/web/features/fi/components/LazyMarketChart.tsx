"use client";

import dynamic from "next/dynamic";
import { memo } from "react";
import { SkeletonRows } from "@fi/components/UiStates";

type ChartToken = { symbol: string; imageUrl?: string };
type LazyMarketChartProps = {
  pair: string;
  label?: string;
  token0?: ChartToken;
  token1?: ChartToken;
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
        <div className="fi-chart-summary" aria-hidden="true" />
        <div className="fi-chart-frame">
          <div className="fi-chart-overlay"><SkeletonRows count={4} label="Loading price chart" /></div>
        </div>
      </section>
    ),
  },
);

function sameToken(a?: ChartToken, b?: ChartToken) {
  return a?.symbol === b?.symbol && a?.imageUrl === b?.imageUrl;
}

/** Pool pages pass fresh token objects on every keystroke; compare by value so the chart only renders on real changes. */
export const LazyMarketChart = memo(function LazyMarketChart(props: LazyMarketChartProps) {
  return <MarketChart {...props} />;
}, (prev, next) => prev.pair === next.pair
  && prev.label === next.label
  && sameToken(prev.token0, next.token0)
  && sameToken(prev.token1, next.token1));
