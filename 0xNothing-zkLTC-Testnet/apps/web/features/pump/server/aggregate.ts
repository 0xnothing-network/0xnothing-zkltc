import "server-only";

import type {
  PumpCandle,
  PumpCandlePeriod,
  PumpTrade,
} from "@/features/pump/types";
import { decimalMax, decimalMin } from "./values";

/**
 * Pure aggregation over trades: de-duplicating a live RPC head against indexed
 * trades, folding live trades into indexed candles, and building candles from
 * trades alone when no candle index is available.
 */

export function mergePumpTrades(liveTrades: PumpTrade[], indexedTrades: PumpTrade[]) {
  const merged = new Map<string, PumpTrade>();
  for (const trade of [...liveTrades, ...indexedTrades]) {
    const key = `${trade.txHash.toLowerCase()}:${trade.logIndex}`;
    if (!merged.has(key)) merged.set(key, trade);
  }
  return [...merged.values()].sort(
    (left, right) => right.blockNumber - left.blockNumber || right.logIndex - left.logIndex,
  );
}

export function mergeLiveTradesIntoCandles(
  indexedCandles: PumpCandle[],
  liveTrades: PumpTrade[],
  period: PumpCandlePeriod,
  limit: number,
  indexedPrice: string,
): PumpCandle[] {
  if (!liveTrades.length) return indexedCandles.slice(-limit);

  const candles = new Map<number, PumpCandle>(
    indexedCandles.map((candle) => [candle.bucket, { ...candle }]),
  );
  // getLogs returns canonical block/transaction/log order, and the forward
  // chunk scan preserves it. Do not sort by transaction hash: that can change
  // the close price when multiple trades land in the same block.
  for (const trade of liveTrades) {
    if (!trade.timestamp || Number(trade.priceNusd) <= 0) continue;
    const bucket = Math.floor(trade.timestamp / period) * period;
    const existing = candles.get(bucket);
    if (existing) {
      existing.high = decimalMax(existing.high, trade.priceNusd);
      existing.low = decimalMin(existing.low, trade.priceNusd);
      existing.close = trade.priceNusd;
      existing.volumeNusd = (BigInt(existing.volumeNusd) + BigInt(trade.nusdAmount)).toString();
      existing.tradeCount += 1;
      continue;
    }

    const previous = [...candles.values()]
      .filter((candle) => candle.bucket < bucket)
      .sort((left, right) => right.bucket - left.bucket)[0];
    const open = previous?.close
      ?? (Number(indexedPrice) > 0 ? indexedPrice : trade.priceNusd);
    candles.set(bucket, {
      id: `${trade.tokenAddress}-${period}-${bucket}`,
      marketAddress: trade.tokenAddress,
      period,
      bucket,
      timestamp: bucket,
      open,
      high: decimalMax(open, trade.priceNusd),
      low: decimalMin(open, trade.priceNusd),
      close: trade.priceNusd,
      volumeNusd: trade.nusdAmount,
      tradeCount: 1,
    });
  }

  return [...candles.values()]
    .sort((left, right) => left.timestamp - right.timestamp)
    .slice(-limit);
}

export function aggregateCandles(trades: PumpTrade[], period: PumpCandlePeriod): PumpCandle[] {
  const buckets = new Map<number, PumpCandle>();
  let previousClose: string | null = null;
  for (const trade of [...trades].reverse()) {
    if (!trade.timestamp) continue;
    const bucket = Math.floor(trade.timestamp / period) * period;
    const existing = buckets.get(bucket);
    if (!existing) {
      const open = previousClose ?? trade.priceNusd;
      buckets.set(bucket, {
        id: `${trade.tokenAddress}-${period}-${bucket}`,
        marketAddress: trade.tokenAddress,
        period,
        bucket,
        timestamp: bucket,
        open,
        high: decimalMax(open, trade.priceNusd),
        low: decimalMin(open, trade.priceNusd),
        close: trade.priceNusd,
        volumeNusd: trade.nusdAmount,
        tradeCount: 1,
      });
      previousClose = trade.priceNusd;
      continue;
    }
    existing.high = decimalMax(existing.high, trade.priceNusd);
    existing.low = decimalMin(existing.low, trade.priceNusd);
    existing.close = trade.priceNusd;
    existing.volumeNusd = (BigInt(existing.volumeNusd) + BigInt(trade.nusdAmount)).toString();
    existing.tradeCount += 1;
    previousClose = trade.priceNusd;
  }
  return [...buckets.values()].sort((a, b) => a.timestamp - b.timestamp);
}
