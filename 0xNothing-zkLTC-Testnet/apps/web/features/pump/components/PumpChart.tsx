"use client";

import { useEffect, useRef, useState } from "react";
import {
  ColorType,
  createChart,
  TickMarkType,
  type CandlestickData,
  type HistogramData,
  type IChartApi,
  type ISeriesApi,
  type Time,
} from "lightweight-charts";
import type { Address } from "viem";
import { CHART_FONT_FAMILY } from "@/lib/chartTheme";
import { usePumpCandles } from "@/features/pump/hooks/usePumpData";
import { PumpInlineLoading } from "@/features/pump/components/PumpStates";
import {
  DEFAULT_PUMP_CANDLE_PERIOD,
  type PumpCandle,
  type PumpCandlePeriod,
} from "@/features/pump/types";

const PERIODS = [
  { label: "1m", value: 60 },
  { label: "15m", value: 900 },
  { label: "1h", value: 3600 },
  { label: "4h", value: 14_400 },
  { label: "1d", value: 86_400 },
] as const satisfies ReadonlyArray<{ label: string; value: PumpCandlePeriod }>;

type CandlePoint = CandlestickData<Time>;
type VolumePoint = HistogramData<Time>;
type ChartPoints = {
  candles: CandlePoint[];
  volumes: VolumePoint[];
};
type ChartDataState = ChartPoints & { context: string };

const MIN_VISIBLE_LOGICAL_BARS = 32;
const RIGHT_PADDING_BARS = 4;

function padTimePart(value: number) {
  return value.toString().padStart(2, "0");
}

function timeToLocalDate(time: Time) {
  if (typeof time === "number") return new Date(time * 1_000);
  if (typeof time === "string") {
    const [year, month, day] = time.split("-").map(Number);
    return new Date(year, month - 1, day);
  }
  return new Date(time.year, time.month - 1, time.day);
}

function formatLocalTick(time: Time, tickMarkType: TickMarkType) {
  const date = timeToLocalDate(time);
  if (!Number.isFinite(date.getTime())) return null;

  if (tickMarkType === TickMarkType.Year) return date.getFullYear().toString();
  if (tickMarkType === TickMarkType.Month) {
    return `${padTimePart(date.getMonth() + 1)}/${date.getFullYear()}`;
  }
  if (tickMarkType === TickMarkType.DayOfMonth) {
    return `${padTimePart(date.getDate())}/${padTimePart(date.getMonth() + 1)}`;
  }

  const clock = `${padTimePart(date.getHours())}:${padTimePart(date.getMinutes())}`;
  return tickMarkType === TickMarkType.TimeWithSeconds
    ? `${clock}:${padTimePart(date.getSeconds())}`
    : clock;
}

function formatLocalCrosshairTime(time: Time) {
  const date = timeToLocalDate(time);
  if (!Number.isFinite(date.getTime())) return "";
  return `${padTimePart(date.getDate())}/${padTimePart(date.getMonth() + 1)} ${padTimePart(date.getHours())}:${padTimePart(date.getMinutes())}`;
}

function buildChartPoints(candles: PumpCandle[]): ChartPoints {
  const normalized = candles
    .map((candle) => {
      const time = Number(candle.timestamp);
      const open = Number(candle.open);
      const high = Number(candle.high);
      const low = Number(candle.low);
      const close = Number(candle.close);
      const tradeCount = Math.max(0, Number(candle.tradeCount) || 0);
      if (
        ![time, open, high, low, close].every(Number.isFinite) ||
        Math.min(open, high, low, close) <= 0 ||
        tradeCount < 1
      ) return null;

      const rawVolume = Number(candle.volumeNusd);
      return {
        candle: {
          time: time as Time,
          open,
          high: Math.max(high, open, close),
          low: Math.min(low, open, close),
          close,
        } as CandlePoint,
        volume: Number.isFinite(rawVolume) ? rawVolume / 1e18 : 0,
      };
    })
    .filter((point): point is NonNullable<typeof point> => point !== null)
    .sort((left, right) => Number(left.candle.time) - Number(right.candle.time));

  const unique: typeof normalized = [];
  for (const point of normalized) {
    if (unique.length && unique[unique.length - 1].candle.time === point.candle.time) {
      unique[unique.length - 1] = point;
    } else {
      unique.push(point);
    }
  }

  const visible = unique.map((point, index) => {
    if (index === 0) return point;

    const previousClose = unique[index - 1].candle.close;
    return {
      ...point,
      candle: {
        ...point.candle,
        open: previousClose,
        high: Math.max(point.candle.high, previousClose),
        low: Math.min(point.candle.low, previousClose),
      },
    };
  });

  return {
    candles: visible.map((point) => point.candle),
    volumes: visible.map((point) => ({
      time: point.candle.time,
      value: point.volume,
      color: point.candle.close >= point.candle.open
        ? "rgba(119,255,177,0.28)"
        : "rgba(255,102,125,0.28)",
    })),
  };
}

function adaptivePriceFormat(points: CandlePoint[]) {
  const positivePrices = points
    .flatMap((point) => [point.open, point.high, point.low, point.close])
    .filter((price) => price > 0 && Number.isFinite(price));
  const reference = positivePrices.length ? Math.min(...positivePrices) : 1;
  const precision = Math.min(
    18,
    Math.max(2, Math.ceil(-Math.log10(reference)) + 6),
  );
  return {
    key: precision.toString(),
    options: { type: "price" as const, precision, minMove: 10 ** -precision },
  };
}

function candlePointsEqual(left: CandlePoint, right: CandlePoint) {
  return (
    left.time === right.time &&
    left.open === right.open &&
    left.high === right.high &&
    left.low === right.low &&
    left.close === right.close &&
    left.color === right.color &&
    left.wickColor === right.wickColor &&
    left.borderColor === right.borderColor
  );
}

function volumePointsEqual(left: VolumePoint, right: VolumePoint) {
  return left.time === right.time && left.value === right.value && left.color === right.color;
}

function updateSeriesData<T extends { time: Time }>(
  previous: T[],
  next: T[],
  pointsEqual: (left: T, right: T) => boolean,
  setData: (points: T[]) => void,
  update: (point: T) => void,
) {
  let firstDifference = 0;
  const sharedLength = Math.min(previous.length, next.length);

  while (
    firstDifference < sharedLength &&
    pointsEqual(previous[firstDifference], next[firstDifference])
  ) {
    firstDifference += 1;
  }

  if (firstDifference === previous.length && firstDifference === next.length) return;

  // A live candle can change until its bucket closes. Updating only the tail
  // preserves the user's zoom and crosshair position during query refreshes.
  const tailOnlyChange =
    previous.length > 0 &&
    next.length >= previous.length &&
    firstDifference >= previous.length - 1 &&
    firstDifference < next.length &&
    Number(next[firstDifference].time) >= Number(previous[previous.length - 1].time);

  if (tailOnlyChange) {
    for (let index = firstDifference; index < next.length; index += 1) {
      update(next[index]);
    }
    return;
  }

  setData(next);
}

export function PumpChart({ token, tokenName }: { token: Address; tokenName: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<"Candlestick", Time> | null>(null);
  const volumeSeriesRef = useRef<ISeriesApi<"Histogram", Time> | null>(null);
  const dataRef = useRef<ChartDataState>({
    context: "",
    candles: [],
    volumes: [],
  });
  const priceFormatKeyRef = useRef("");
  const fitFrameRef = useRef<number | null>(null);
  const [period, setPeriod] = useState<PumpCandlePeriod>(DEFAULT_PUMP_CANDLE_PERIOD);
  const query = usePumpCandles(token, period);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const chart = createChart(container, {
      autoSize: true,
      height: container.clientHeight || 400,
      layout: {
        background: { type: ColorType.Solid, color: "#090a0c" },
        textColor: "#7f8791",
        fontFamily: CHART_FONT_FAMILY,
        fontSize: 10,
        attributionLogo: false,
      },
      grid: {
        vertLines: { color: "rgba(255,255,255,0.035)" },
        horzLines: { color: "rgba(255,255,255,0.035)" },
      },
      localization: { timeFormatter: formatLocalCrosshairTime },
      rightPriceScale: {
        borderColor: "rgba(255,255,255,0.1)",
        scaleMargins: { top: 0.08, bottom: 0.24 },
      },
      timeScale: {
        borderColor: "rgba(255,255,255,0.1)",
        minBarSpacing: 2,
        rightOffset: 3,
        shiftVisibleRangeOnNewBar: true,
        timeVisible: true,
        secondsVisible: false,
        tickMarkFormatter: formatLocalTick,
      },
      kineticScroll: { mouse: true, touch: true },
      crosshair: {
        vertLine: { color: "rgba(119,255,177,0.4)" },
        horzLine: { color: "rgba(119,255,177,0.4)" },
      },
    });
    chartRef.current = chart;
    const volumeSeries = chart.addHistogramSeries({
      color: "rgba(119,255,177,0.28)",
      priceFormat: { type: "volume" },
      priceLineVisible: false,
      lastValueVisible: false,
      priceScaleId: "volume",
    });
    volumeSeries.priceScale().applyOptions({
      scaleMargins: { top: 0.82, bottom: 0 },
    });
    const candleSeries = chart.addCandlestickSeries({
      upColor: "#77ffb1",
      downColor: "#ff667d",
      wickUpColor: "#77ffb1",
      wickDownColor: "#ff667d",
      borderVisible: false,
      priceLineVisible: false,
      priceFormat: { type: "price", precision: 8, minMove: 0.00000001 },
    });
    candleSeriesRef.current = candleSeries;
    volumeSeriesRef.current = volumeSeries;

    return () => {
      if (fitFrameRef.current !== null) cancelAnimationFrame(fitFrameRef.current);
      chart.remove();
      chartRef.current = null;
      candleSeriesRef.current = null;
      volumeSeriesRef.current = null;
      dataRef.current = { context: "", candles: [], volumes: [] };
      priceFormatKeyRef.current = "";
    };
  }, []);

  useEffect(() => {
    const chart = chartRef.current;
    const candleSeries = candleSeriesRef.current;
    const volumeSeries = volumeSeriesRef.current;
    const candles = query.data?.candles;
    if (!chart || !candleSeries || !volumeSeries || !candles) return;

    const points = buildChartPoints(candles);
    const context = `${token.toLowerCase()}:${period}`;
    const previous = dataRef.current;
    const priceFormat = adaptivePriceFormat(points.candles);

    if (priceFormatKeyRef.current !== priceFormat.key) {
      candleSeries.applyOptions({ priceFormat: priceFormat.options });
      priceFormatKeyRef.current = priceFormat.key;
    }

    if (previous.context === context) {
      updateSeriesData(
        previous.candles,
        points.candles,
        candlePointsEqual,
        (data) => candleSeries.setData(data),
        (point) => candleSeries.update(point),
      );
      updateSeriesData(
        previous.volumes,
        points.volumes,
        volumePointsEqual,
        (data) => volumeSeries.setData(data),
        (point) => volumeSeries.update(point),
      );
    } else {
      candleSeries.setData(points.candles);
      volumeSeries.setData(points.volumes);
    }
    dataRef.current = { context, ...points };

    if (previous.context !== context && points.candles.length) {
      if (fitFrameRef.current !== null) cancelAnimationFrame(fitFrameRef.current);
      fitFrameRef.current = requestAnimationFrame(() => {
        if (points.candles.length < MIN_VISIBLE_LOGICAL_BARS) {
          chart.timeScale().setVisibleLogicalRange({
            from: points.candles.length - MIN_VISIBLE_LOGICAL_BARS,
            to: points.candles.length - 1 + RIGHT_PADDING_BARS,
          });
        } else {
          chart.timeScale().fitContent();
        }
        fitFrameRef.current = null;
      });
    }
  }, [period, query.data?.candles, token]);

  return (
    <section className="pump-panel pump-chart-panel">
      <div className="pump-panel-heading pump-chart-heading">
        <div><span className="pump-eyebrow">Bonding curve</span><h2>{tokenName} / NUSD</h2></div>
        <div className="pump-segmented pump-periods" role="group" aria-label="Chart interval">
          {PERIODS.map((item) => (
            <button key={item.value} type="button" className={period === item.value ? "active" : ""} aria-pressed={period === item.value} onClick={() => setPeriod(item.value)}>{item.label}</button>
          ))}
        </div>
      </div>
      <div className="pump-chart" ref={containerRef} role="img" aria-label={`${tokenName} price candlestick chart, ${PERIODS.find((item) => item.value === period)?.label ?? "selected"} interval, ${query.data?.candles.length ?? 0} indexed candles`} />
      {query.isLoading ? (
        <div className="pump-chart-loading"><PumpInlineLoading label="Loading chart" /></div>
      ) : query.error ? (
        <div className="pump-chart-message" role="alert">
          <span>Chart unavailable</span>
          <button type="button" onClick={() => void query.refetch()}>Retry</button>
        </div>
      ) : !query.isLoading && !query.data?.candles.length ? (
        <p className="pump-chart-message">Chart data appears after the first indexed trade.</p>
      ) : null}
    </section>
  );
}
