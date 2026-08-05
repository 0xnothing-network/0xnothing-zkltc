import { NextRequest, NextResponse } from "next/server";
import { createPublicClient, formatUnits, getAddress, http, isAddress } from "viem";
import { assetForPool, canonicalPairs, deployedPairForSlug, pairSlug, parsePairSlug } from "@/config/assets";
import type { CandlePoint, DataEnvelope } from "@/lib/data";
import { queryGoldsky, unconfiguredEnvelope } from "@/lib/server/goldsky";
import { deployment } from "@/config/deployment";
import { diaOracleAdapterAbi } from "@/lib/abis/dia";
import { canonicalOracleMarketForIdentifier } from "@/lib/canonicalMarkets";
import { decimal, isFactoryPair, loadPairTail, pairForTokens, pairTokenMetadata } from "@/lib/server/rpcTail";

const PERIODS = { "5m": 300, "1h": 3_600, "4h": 14_400, "1d": 86_400 } as const;
const client = createPublicClient({ transport: http(deployment.chain.rpcUrl) });
const QUERY = `
  query Candles($pool: Bytes!, $period: Int!, $first: Int!) {
    _meta { block { number } }
    candles(where: { pool: $pool, period: $period }, first: $first, orderBy: timestamp, orderDirection: desc) {
      timestamp open high low close volumeNusd
    }
  }
`;

type Result = {
  candles?: Array<Record<"timestamp" | "open" | "high" | "low" | "close" | "volumeNusd", string>>;
};

function finite(value: string): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function units(value: string, decimals: number): number {
  try {
    return decimal(BigInt(value), decimals);
  } catch {
    return 0;
  }
}

function normalizeCandles(source: CandlePoint[]): CandlePoint[] {
  const unique = new Map<number, CandlePoint>();
  for (const point of source) {
    const time = Number(point.time);
    const open = Number(point.open);
    const high = Number(point.high);
    const low = Number(point.low);
    const close = Number(point.close);
    if (
      ![time, open, high, low, close].every(Number.isFinite)
      || time <= 0
      || Math.min(open, high, low, close) <= 0
    ) continue;
    const volume = Number(point.volume);
    unique.set(time, {
      time,
      open,
      high: Math.max(high, open, close),
      low: Math.min(low, open, close),
      close,
      volume: Number.isFinite(volume) && volume > 0 ? volume : 0,
    });
  }

  const candles = [...unique.values()].sort((left, right) => left.time - right.time);
  return candles.map((point, index) => {
    if (index === 0) return point;
    const previousClose = candles[index - 1].close;
    return {
      ...point,
      open: previousClose,
      high: Math.max(point.high, previousClose),
      low: Math.min(point.low, previousClose),
    };
  });
}

export async function GET(request: NextRequest) {
  const pair = request.nextUrl.searchParams.get("pair")?.toLowerCase() || "";
  const period = request.nextUrl.searchParams.get("period") || "1h";
  const validPairs = canonicalPairs.map(([a, b]) => pairSlug(a, b));
  const dynamicPool = isAddress(pair) ? getAddress(pair) : undefined;
  if ((!dynamicPool && !validPairs.includes(pair)) || !(period in PERIODS)) {
    return NextResponse.json({ error: "Unsupported pair or period." }, { status: 400 });
  }

  try {
    const canonicalMarket = canonicalOracleMarketForIdentifier(pair);
    if (canonicalMarket) {
      if (!canonicalMarket.oracle) {
        return NextResponse.json(
          { error: "DIA oracle is not configured for this market." },
          { status: 503 },
        );
      }
      const [snapshot, fresh, blockNumber] = await Promise.all([
        client.readContract({
          address: canonicalMarket.oracle,
          abi: diaOracleAdapterAbi,
          functionName: "readPriceWad",
        }),
        client.readContract({
          address: canonicalMarket.oracle,
          abi: diaOracleAdapterAbi,
          functionName: "isFresh",
        }),
        client.getBlockNumber(),
      ]);
      const [priceWad, updatedAt, roundId] = snapshot;
      if (priceWad <= 0n || updatedAt <= 0n) throw new Error("DIA oracle returned an invalid snapshot");
      const oraclePrice = Number(formatUnits(priceWad, 18));
      if (!Number.isFinite(oraclePrice) || oraclePrice <= 0) throw new Error("DIA oracle returned an invalid price");
      const snapshotTime = Number(updatedAt);
      const envelope: DataEnvelope<CandlePoint[]> = {
        data: [{
          time: snapshotTime,
          open: oraclePrice,
          high: oraclePrice,
          low: oraclePrice,
          close: oraclePrice,
          volume: 0,
        }],
        meta: {
          source: "rpc",
          indexedBlock: null,
          generatedAt: new Date().toISOString(),
          rpcTail: {
            status: "merged",
            fromBlock: Number(blockNumber),
            toBlock: Number(blockNumber),
            merged: true,
            eventCount: 0,
          },
          priceSource: "oracle",
          oracle: { updatedAt: snapshotTime, roundId: roundId.toString() },
        },
        warning: fresh ? undefined : "DIA oracle snapshot is stale.",
      };
      return NextResponse.json(envelope);
    }

    const symbols = dynamicPool ? undefined : parsePairSlug(pair)!;
    if (dynamicPool && !(await isFactoryPair(deployment.contracts.dexFactory, dynamicPool))) {
      return NextResponse.json({ error: "Unsupported pair." }, { status: 400 });
    }
    const pool = dynamicPool ?? deployedPairForSlug(pair) ?? await pairForTokens(
      deployment.contracts.dexFactory,
      symbols ? assetForPool(symbols[0]) : undefined,
      symbols ? assetForPool(symbols[1]) : undefined,
    );
    if (!pool) return NextResponse.json(unconfiguredEnvelope([], "Pair address is not configured for indexed history."));
    let envelope: DataEnvelope<CandlePoint[]>;
    try {
      envelope = await queryGoldsky<Result, CandlePoint[]>(
        QUERY,
        { pool: pool.toLowerCase(), period: PERIODS[period as keyof typeof PERIODS], first: 500 },
        (data) => (data.candles || []).map((point) => ({
          time: Number(point.timestamp),
          open: finite(point.open),
          high: finite(point.high),
          low: finite(point.low),
          close: finite(point.close),
          volume: units(point.volumeNusd, 18),
        })).filter((point) => point.time > 0 && point.high >= point.low)
          .sort((a, b) => a.time - b.time),
        [],
      );
    } catch (error) {
      envelope = unconfiguredEnvelope<CandlePoint[]>([], `Goldsky unavailable: ${error instanceof Error ? error.message : "query failed"}`);
    }
    try {
      const [tail, metadata] = await Promise.all([
        loadPairTail(pool, envelope.meta.indexedBlock),
        pairTokenMetadata(pool),
      ]);
      const invert = Boolean(
        deployment.contracts.nusd
        && metadata.token0.toLowerCase() === deployment.contracts.nusd.toLowerCase(),
      );
      const token1IsNusd = Boolean(
        deployment.contracts.nusd
        && metadata.token1.toLowerCase() === deployment.contracts.nusd.toLowerCase(),
      );
      const seconds = PERIODS[period as keyof typeof PERIODS];
      const byBucket = new Map(envelope.data.map((candle) => [candle.time, candle]));
      let reserve0 = 0n; let reserve1 = 0n; let tailTrades = 0;
      for (const event of tail.events) {
        if (event.kind === "sync") { reserve0 = event.reserve0; reserve1 = event.reserve1; continue; }
        if (event.kind !== "swap" || reserve0 === 0n || reserve1 === 0n) continue;
        if (
          reserve0 + event.amount0Out < event.amount0In
          || reserve1 + event.amount1Out < event.amount1In
        ) continue;
        const reserve0Before = reserve0 - event.amount0In + event.amount0Out;
        const reserve1Before = reserve1 - event.amount1In + event.amount1Out;
        if (reserve0Before === 0n || reserve1Before === 0n) continue;
        const rawPriceAfter = decimal(reserve1, metadata.decimals1) / decimal(reserve0, metadata.decimals0);
        const rawPriceBefore = decimal(reserve1Before, metadata.decimals1) / decimal(reserve0Before, metadata.decimals0);
        const priceNusd = invert ? 1 / rawPriceAfter : rawPriceAfter;
        const priceBeforeNusd = invert ? 1 / rawPriceBefore : rawPriceBefore;
        if (
          !Number.isFinite(priceNusd)
          || !Number.isFinite(priceBeforeNusd)
          || priceNusd <= 0
          || priceBeforeNusd <= 0
        ) continue;
        const bucket = Math.floor(event.timestamp / seconds) * seconds;
        const volume = invert
          ? decimal(event.amount0In + event.amount0Out, metadata.decimals0)
          : token1IsNusd
            ? decimal(event.amount1In + event.amount1Out, metadata.decimals1)
            : 0;
        const current = byBucket.get(bucket);
        byBucket.set(bucket, current
          ? {
              ...current,
              high: Math.max(current.high, priceBeforeNusd, priceNusd),
              low: Math.min(current.low, priceBeforeNusd, priceNusd),
              close: priceNusd,
              volume: current.volume + volume,
            }
          : {
              time: bucket,
              open: priceBeforeNusd,
              high: Math.max(priceBeforeNusd, priceNusd),
              low: Math.min(priceBeforeNusd, priceNusd),
              close: priceNusd,
              volume,
            });
        tailTrades += 1;
      }
      envelope.data = [...byBucket.values()].sort((a, b) => a.time - b.time).slice(-500);
      envelope.meta.rpcTail = { status: tail.capped ? "capped" : "merged", fromBlock: Number(tail.fromBlock), toBlock: Number(tail.toBlock), merged: true, eventCount: tailTrades };
    } catch (error) {
      envelope.meta.rpcTail.status = "unavailable";
      envelope.warning = `${envelope.warning ? `${envelope.warning} ` : ""}RPC tail unavailable: ${error instanceof Error ? error.message : "request failed"}`;
    }
    envelope.data = normalizeCandles(envelope.data).slice(-500);
    envelope.meta.priceSource = "dex";
    return NextResponse.json(envelope);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Indexer query failed";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
