"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  createChart,
  ColorType,
  LineStyle,
  TickMarkType,
  type CandlestickData,
  type HistogramData,
  type IChartApi,
  type ISeriesApi,
  type Time,
  type UTCTimestamp,
} from "lightweight-charts";
import { TokenPairLogos } from "@fi/components/TokenLogo";
import { EmptyState, ErrorState, SkeletonRows } from "@fi/components/UiStates";
import { fiPath } from "@fi/config/paths";
import type { CandlePoint, DataEnvelope } from "@fi/lib/data";
import { fiPollInterval } from "@fi/lib/hooks/useFiPolling";
import { fetchJson } from "@/lib/http";

type Period = "5m" | "1h" | "4h" | "1d";
const PERIODS: readonly Period[] = ["5m", "1h", "4h", "1d"];
const PERIOD_SECONDS: Record<Period, number> = { "5m": 300, "1h": 3_600, "4h": 14_400, "1d": 86_400 };

type Readout = { open: number; high: number; low: number; close: number; volume: number };
type ChartToken = { symbol: string; imageUrl?: string };
type ChartCandle = CandlestickData<Time>;
type ChartVolume = HistogramData<Time>;
type ChartDataState = {
  context: string;
  candles: ChartCandle[];
  volumes: ChartVolume[];
};

const MIN_VISIBLE_LOGICAL_BARS = 32;
const RIGHT_PADDING_BARS = 4;
const CHART_FRESH_MS = 12_000;

function price(value: number): string {
  return value.toLocaleString(undefined, {
    maximumFractionDigits: value < 0.0001 ? 18 : value < 1 ? 8 : 4,
  });
}

function padTimePart(value: number): string {
  return value.toString().padStart(2, "0");
}

function timeToLocalDate(time: Time): Date {
  if (typeof time === "number") return new Date(time * 1_000);
  if (typeof time === "string") {
    const [year, month, day] = time.split("-").map(Number);
    return new Date(year, month - 1, day);
  }
  return new Date(time.year, time.month - 1, time.day);
}

function formatLocalTick(time: Time, tickMarkType: TickMarkType): string | null {
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

function formatLocalCrosshairTime(time: Time): string {
  const date = timeToLocalDate(time);
  if (!Number.isFinite(date.getTime())) return "";
  return `${padTimePart(date.getDate())}/${padTimePart(date.getMonth() + 1)} ${padTimePart(date.getHours())}:${padTimePart(date.getMinutes())}`;
}

function buildChartPoints(source: CandlePoint[]): { candles: ChartCandle[]; volumes: ChartVolume[] } {
  const normalized = source
    .map((point) => {
      const time = Number(point.time);
      const open = Number(point.open);
      const high = Number(point.high);
      const low = Number(point.low);
      const close = Number(point.close);
      if (
        ![time, open, high, low, close].every(Number.isFinite)
        || time <= 0
        || Math.min(open, high, low, close) <= 0
      ) return null;
      const volume = Number(point.volume);
      return {
        candle: {
          time: time as Time,
          open,
          high: Math.max(high, open, close),
          low: Math.min(low, open, close),
          close,
        } as ChartCandle,
        volume: Number.isFinite(volume) && volume > 0 ? volume : 0,
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
        ? "rgba(119,255,177,.28)"
        : "rgba(255,102,125,.28)",
    })),
  };
}

function adaptivePriceFormat(points: ChartCandle[]) {
  const positivePrices = points
    .flatMap((point) => [point.open, point.high, point.low, point.close])
    .filter((point) => point > 0 && Number.isFinite(point));
  const reference = positivePrices.length ? Math.min(...positivePrices) : 1;
  const precision = Math.min(18, Math.max(2, Math.ceil(-Math.log10(reference)) + 6));
  return { type: "price" as const, precision, minMove: 10 ** -precision };
}

function candlePointsEqual(left: ChartCandle, right: ChartCandle): boolean {
  return (
    left.time === right.time
    && left.open === right.open
    && left.high === right.high
    && left.low === right.low
    && left.close === right.close
    && left.color === right.color
    && left.wickColor === right.wickColor
    && left.borderColor === right.borderColor
  );
}

function volumePointsEqual(left: ChartVolume, right: ChartVolume): boolean {
  return left.time === right.time && left.value === right.value && left.color === right.color;
}

function updateSeriesData<T extends { time: Time }>(
  previous: T[],
  next: T[],
  pointsEqual: (left: T, right: T) => boolean,
  setData: (points: T[]) => void,
  update: (point: T) => void,
): void {
  let firstDifference = 0;
  const sharedLength = Math.min(previous.length, next.length);
  while (firstDifference < sharedLength && pointsEqual(previous[firstDifference], next[firstDifference])) {
    firstDifference += 1;
  }
  if (firstDifference === previous.length && firstDifference === next.length) return;

  const tailOnlyChange = previous.length > 0
    && next.length >= previous.length
    && firstDifference >= previous.length - 1
    && firstDifference < next.length
    && Number(next[firstDifference].time) >= Number(previous[previous.length - 1].time);
  if (tailOnlyChange) {
    for (let index = firstDifference; index < next.length; index += 1) update(next[index]);
    return;
  }
  setData(next);
}

function compact(value: number): string {
  return value.toLocaleString(undefined, {
    notation: value >= 10_000 ? "compact" : "standard",
    maximumFractionDigits: 2,
  });
}

export function MarketChart({
  pair,
  label,
  token0,
  token1,
}: {
  pair: string;
  label?: string;
  token0?: ChartToken;
  token1?: ChartToken;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<"Candlestick", Time> | null>(null);
  const volumeSeriesRef = useRef<ISeriesApi<"Histogram", Time> | null>(null);
  const oracleSeriesRef = useRef<ISeriesApi<"Line", Time> | null>(null);
  const oraclePriceLineRef = useRef<ReturnType<ISeriesApi<"Line", Time>["createPriceLine"]> | null>(null);
  const volumeByTimeRef = useRef(new Map<number, number>());
  const dataRef = useRef<ChartDataState>({ context: "", candles: [], volumes: [] });
  const priceFormatKeyRef = useRef("");
  const fitFrameRef = useRef<number | null>(null);
  const requestIdRef = useRef(0);
  const requestAbortRef = useRef<AbortController | null>(null);
  const lastUpdatedAtRef = useRef(0);
  const [period, setPeriod] = useState<Period>("1h");
  const [candles, setCandles] = useState<CandlePoint[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [hover, setHover] = useState<Readout | null>(null);
  const [priceSource, setPriceSource] = useState<"oracle" | "dex">();
  const [oracleUpdatedAt, setOracleUpdatedAt] = useState<number>();
  const chartPoints = useMemo(() => buildChartPoints(candles), [candles]);
  const hasChartData = chartPoints.candles.length > 0;

  const load = useCallback(async (background = false) => {
    requestAbortRef.current?.abort();
    const controller = new AbortController();
    requestAbortRef.current = controller;
    const requestId = ++requestIdRef.current;
    if (!background) setLoading(true);
    try {
      const payload = await fetchJson<DataEnvelope<CandlePoint[]>>(
        fiPath(`/api/data/candles?pair=${encodeURIComponent(pair)}&period=${period}`),
        { signal: controller.signal },
        "Chart request failed",
      );
      if (requestId !== requestIdRef.current) return;
      setCandles(payload.data);
      setPriceSource(payload.meta.priceSource ?? "dex");
      setOracleUpdatedAt(payload.meta.oracle?.updatedAt);
      lastUpdatedAtRef.current = Date.now();
      setError(undefined);
    } catch (reason) {
      if (controller.signal.aborted) return;
      if (requestId !== requestIdRef.current) return;
      setError(reason instanceof Error ? reason.message : "Chart request failed");
    } finally {
      if (requestAbortRef.current === controller) requestAbortRef.current = null;
      if (requestId === requestIdRef.current) setLoading(false);
    }
  }, [pair, period]);

  useEffect(() => {
    let disposed = false;
    let generation = 0;
    let timer: number | undefined;
    const pollInterval = fiPollInterval(`chart:${pair.toLowerCase()}:${period}`);

    const schedule = (delay = pollInterval) => {
      if (disposed || document.visibilityState === "hidden") return;
      timer = window.setTimeout(() => void refresh(true), delay);
    };
    const refresh = async (background: boolean) => {
      const currentGeneration = ++generation;
      if (document.visibilityState === "hidden") return;
      await load(background);
      if (!disposed && currentGeneration === generation) schedule();
    };
    const onVisibilityChange = () => {
      if (timer !== undefined) window.clearTimeout(timer);
      timer = undefined;
      generation += 1;
      if (document.visibilityState === "hidden") {
        requestAbortRef.current?.abort();
        return;
      }
      const age = Date.now() - lastUpdatedAtRef.current;
      if (age >= CHART_FRESH_MS) {
        void refresh(true);
      } else {
        schedule(Math.max(500, pollInterval - age));
      }
    };

    document.addEventListener("visibilitychange", onVisibilityChange);
    void refresh(false);
    return () => {
      disposed = true;
      generation += 1;
      if (timer !== undefined) window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      requestAbortRef.current?.abort();
      requestIdRef.current += 1;
    };
  }, [load, pair, period]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !hasChartData || !priceSource) return;

    const chart = createChart(host, {
      width: host.clientWidth,
      height: host.clientHeight,
      layout: {
        background: { type: ColorType.Solid, color: "#0c0e10" },
        textColor: "#9299a1",
        attributionLogo: false,
      },
      grid: {
        vertLines: { color: "rgba(255,255,255,.04)" },
        horzLines: { color: "rgba(255,255,255,.06)" },
      },
      localization: { timeFormatter: formatLocalCrosshairTime },
      rightPriceScale: {
        borderColor: "rgba(255,255,255,.12)",
        scaleMargins: { top: 0.08, bottom: 0.24 },
      },
      timeScale: {
        borderColor: "rgba(255,255,255,.12)",
        minBarSpacing: 2,
        rightOffset: 3,
        shiftVisibleRangeOnNewBar: true,
        timeVisible: true,
        secondsVisible: false,
        tickMarkFormatter: formatLocalTick,
      },
      kineticScroll: { mouse: true, touch: true },
      crosshair: { vertLine: { color: "#687078" }, horzLine: { color: "#687078" } },
      handleScroll: true,
      handleScale: true,
    });
    let onMove: Parameters<IChartApi["subscribeCrosshairMove"]>[0] | undefined;

    if (priceSource === "oracle") {
      const series = chart.addLineSeries({
        color: "#77ffb1",
        lineWidth: 2,
        lineVisible: false,
        pointMarkersVisible: true,
        lastValueVisible: false,
        priceLineVisible: false,
        priceFormat: { type: "price", precision: 8, minMove: 0.00000001 },
      });
      oracleSeriesRef.current = series;
      onMove = (param) => {
        const point = param.time && param.point
          ? (param.seriesData.get(series as ISeriesApi<"Line">) as { value: number } | undefined)
          : undefined;
        setHover(point
          ? { open: point.value, high: point.value, low: point.value, close: point.value, volume: 0 }
          : null);
      };
    } else {
      const series = chart.addCandlestickSeries({
        upColor: "#77ffb1",
        downColor: "#ff667d",
        wickUpColor: "#77ffb1",
        wickDownColor: "#ff667d",
        borderVisible: false,
        priceLineVisible: false,
        priceFormat: { type: "price", precision: 8, minMove: 0.00000001 },
      });
      const volumeSeries = chart.addHistogramSeries({
        priceScaleId: "volume",
        priceFormat: { type: "volume" },
        lastValueVisible: false,
        priceLineVisible: false,
      });
      volumeSeries.priceScale().applyOptions({ visible: false, scaleMargins: { top: 0.82, bottom: 0 } });
      candleSeriesRef.current = series;
      volumeSeriesRef.current = volumeSeries;
      onMove = (param) => {
        const bar = param.time && param.point
          ? (param.seriesData.get(series as ISeriesApi<"Candlestick">) as
              { open: number; high: number; low: number; close: number } | undefined)
          : undefined;
        if (!bar) { setHover(null); return; }
        setHover({ ...bar, volume: volumeByTimeRef.current.get(Number(param.time)) ?? 0 });
      };
    }
    chartRef.current = chart;
    chart.subscribeCrosshairMove(onMove);

    const observer = new ResizeObserver(() => chart.applyOptions({
      width: host.clientWidth,
      height: host.clientHeight,
    }));
    observer.observe(host);
    return () => {
      chart.unsubscribeCrosshairMove(onMove);
      observer.disconnect();
      chart.remove();
      chartRef.current = null;
      candleSeriesRef.current = null;
      volumeSeriesRef.current = null;
      oracleSeriesRef.current = null;
      oraclePriceLineRef.current = null;
      volumeByTimeRef.current.clear();
      dataRef.current = { context: "", candles: [], volumes: [] };
      priceFormatKeyRef.current = "";
      if (fitFrameRef.current !== null) cancelAnimationFrame(fitFrameRef.current);
      fitFrameRef.current = null;
      setHover(null);
    };
  }, [hasChartData, priceSource]);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || !chartPoints.candles.length || !priceSource) return;
    const priceFormat = adaptivePriceFormat(chartPoints.candles);
    const priceFormatKey = `${priceFormat.precision}:${priceFormat.minMove}`;

    if (priceSource === "oracle") {
      const snapshot = candles.at(-1);
      const series = oracleSeriesRef.current;
      if (!snapshot || !series) return;
      if (priceFormatKeyRef.current !== priceFormatKey) {
        series.applyOptions({ priceFormat });
        priceFormatKeyRef.current = priceFormatKey;
      }
      series.setData([{ time: snapshot.time as UTCTimestamp, value: snapshot.close }]);
      if (oraclePriceLineRef.current) {
        oraclePriceLineRef.current.applyOptions({ price: snapshot.close });
      } else {
        oraclePriceLineRef.current = series.createPriceLine({
          price: snapshot.close,
          color: "#77ffb1",
          lineWidth: 1,
          lineStyle: LineStyle.Solid,
          axisLabelVisible: true,
          title: "DIA",
        });
      }
      const context = `${pair.toLowerCase()}:${period}:oracle`;
      if (dataRef.current.context !== context) {
        const span = PERIOD_SECONDS[period] * 60;
        chart.timeScale().setVisibleRange({
          from: Math.max(0, snapshot.time - span) as UTCTimestamp,
          to: (snapshot.time + PERIOD_SECONDS[period] * 3) as UTCTimestamp,
        });
      }
      dataRef.current = { context, candles: chartPoints.candles, volumes: [] };
      return;
    }

    const candleSeries = candleSeriesRef.current;
    const volumeSeries = volumeSeriesRef.current;
    if (!candleSeries || !volumeSeries) return;
    if (priceFormatKeyRef.current !== priceFormatKey) {
      candleSeries.applyOptions({ priceFormat });
      priceFormatKeyRef.current = priceFormatKey;
    }

    const context = `${pair.toLowerCase()}:${period}:dex`;
    const previous = dataRef.current;
    if (previous.context === context) {
      updateSeriesData(
        previous.candles,
        chartPoints.candles,
        candlePointsEqual,
        (points) => candleSeries.setData(points),
        (point) => candleSeries.update(point),
      );
      updateSeriesData(
        previous.volumes,
        chartPoints.volumes,
        volumePointsEqual,
        (points) => volumeSeries.setData(points),
        (point) => volumeSeries.update(point),
      );
    } else {
      candleSeries.setData(chartPoints.candles);
      volumeSeries.setData(chartPoints.volumes);
    }
    volumeByTimeRef.current = new Map(
      chartPoints.volumes.map((point) => [Number(point.time), point.value]),
    );
    dataRef.current = { context, ...chartPoints };

    if (previous.context !== context) {
      if (fitFrameRef.current !== null) cancelAnimationFrame(fitFrameRef.current);
      fitFrameRef.current = requestAnimationFrame(() => {
        if (chartPoints.candles.length < MIN_VISIBLE_LOGICAL_BARS) {
          chart.timeScale().setVisibleLogicalRange({
            from: chartPoints.candles.length - MIN_VISIBLE_LOGICAL_BARS,
            to: chartPoints.candles.length - 1 + RIGHT_PADDING_BARS,
          });
        } else {
          chart.timeScale().fitContent();
        }
        fitFrameRef.current = null;
      });
    }
  }, [candles, chartPoints, pair, period, priceSource]);

  const latest = candles.at(-1);
  const oldest = candles.at(0);
  const change = latest && oldest && oldest.open !== 0
    ? ((latest.close - oldest.open) / oldest.open) * 100
    : undefined;
  const rangeVolume = candles.reduce((sum, candle) => sum + candle.volume, 0);
  const readout: Readout | null = hover ?? (latest
    ? { open: latest.open, high: latest.high, low: latest.low, close: latest.close, volume: latest.volume }
    : null);
  const initialLoading = loading && candles.length === 0;
  const title = label || pair;

  return (
    <section className="fi-panel fi-panel-flush fi-chart-panel" aria-labelledby={`${pair}-chart-title`}>
      <div className="fi-chart-heading">
        <div className="fi-chart-market">
          {token0 && token1 ? <TokenPairLogos token0={token0} token1={token1} size="sm" /> : null}
          <h2 id={`${pair}-chart-title`}>{title}</h2>
        </div>
        {priceSource === "oracle" ? <small>DIA oracle</small> : (
          <div className="fi-segmented" role="group" aria-label="Chart period">
            {PERIODS.map((item) => (
              <button
                type="button"
                className={period === item ? "active" : ""}
                onClick={() => setPeriod(item)}
                aria-pressed={period === item}
                key={item}
              >
                {item}
              </button>
            ))}
          </div>
        )}
      </div>
      {readout ? (
        <div className="fi-chart-summary" aria-live="polite">
          <strong>{price(readout.close)}</strong>
          {priceSource === "oracle" ? (
            <>
              <span data-tone="positive">DIA</span>
              <span className="fi-chart-rangevol">
                {oracleUpdatedAt ? `Updated ${new Date(oracleUpdatedAt * 1000).toLocaleString()}` : "Live snapshot"}
              </span>
            </>
          ) : (
            <>
              <span data-tone={change !== undefined && change < 0 ? "danger" : "positive"} title="Change over the visible range">
                {change === undefined ? "--" : `${change >= 0 ? "+" : ""}${change.toFixed(2)}%`}
              </span>
              <span className="fi-chart-rangevol">Vol {compact(hover ? readout.volume : rangeVolume)}</span>
            </>
          )}
        </div>
      ) : null}
      <div className="fi-chart-frame">
        {candles.length > 0 ? (
          <div className="fi-chart" ref={hostRef} data-updating={loading || undefined} aria-hidden="true" />
        ) : null}
        {initialLoading ? <div className="fi-chart-overlay"><SkeletonRows count={4} label="Loading price chart" /></div> : null}
      </div>
      {!loading && error && candles.length === 0 ? <ErrorState message={error} onRetry={() => void load()} /> : null}
      {!initialLoading && !error && candles.length === 0 ? <EmptyState title={priceSource === "oracle" ? "Oracle price unavailable" : "No candles yet"} /> : null}
      {candles.length > 0 ? (
        <details className="fi-chart-a11y">
          <summary>{priceSource === "oracle" ? "Oracle snapshot" : "OHLC data"}</summary>
          <div className="fi-table-wrap">
            {priceSource === "oracle" ? (
              <table className="fi-table">
                <caption>DIA oracle snapshot for {title}</caption>
                <thead><tr><th scope="col">Updated</th><th scope="col">Price</th><th scope="col">Source</th></tr></thead>
                <tbody><tr><td>{new Date(candles.at(-1)!.time * 1000).toLocaleString()}</td><td>{candles.at(-1)!.close}</td><td>DIA</td></tr></tbody>
              </table>
            ) : (
              <table className="fi-table">
                <caption>Most recent {Math.min(candles.length, 30)} {period} candles for {title}</caption>
                <thead><tr><th scope="col">Time</th><th scope="col">Open</th><th scope="col">High</th><th scope="col">Low</th><th scope="col">Close</th><th scope="col">Volume</th></tr></thead>
                <tbody>
                  {candles.slice(-30).reverse().map((candle) => (
                    <tr key={candle.time}>
                      <td>{new Date(candle.time * 1000).toLocaleString()}</td>
                      <td>{candle.open}</td><td>{candle.high}</td><td>{candle.low}</td><td>{candle.close}</td><td>{candle.volume}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </details>
      ) : null}
    </section>
  );
}
