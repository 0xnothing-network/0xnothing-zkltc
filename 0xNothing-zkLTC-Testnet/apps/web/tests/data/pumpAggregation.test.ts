import assert from "node:assert/strict";
import test from "node:test";
import { decimalMax, decimalMin } from "../../features/pump/decimal.ts";
import type { PumpCandle, PumpTrade } from "../../features/pump/types.ts";
import type * as Aggregation from "../../features/pump/server/aggregate.ts";
import { evaluateModule } from "../helpers/evaluateModule.ts";

const { mergeLiveTradesIntoCandles, mergePumpTrades } = evaluateModule<typeof Aggregation>(
  new URL("../../features/pump/server/aggregate.ts", import.meta.url),
  { "server-only": {}, "./values": { decimalMax, decimalMin } },
);
const address = `0x${"1".repeat(40)}` as const;
function trade(timestamp: number, priceNusd: string, logIndex = 0): PumpTrade {
  return {
    id: `trade-${timestamp}-${logIndex}`, marketAddress: address, tokenAddress: address,
    trader: address, side: "BUY", nusdAmount: "9007199254740993000",
    userNusdAmount: "1", tokenAmount: "1", feeNusd: "0", priceNusd,
    timestamp, blockNumber: timestamp, logIndex, txHash: `0x${"a".repeat(64)}`,
  };
}

test("live candles retain exact prices, volume, prior close and event order without mutating indexed data", () => {
  const indexed: PumpCandle[] = [
    { id: "first", marketAddress: address, period: 60, bucket: 60, timestamp: 60,
      open: "1", high: "3", low: "1", close: "3", volumeNusd: "0", tradeCount: 1 },
    { id: "later", marketAddress: address, period: 60, bucket: 300, timestamp: 300,
      open: "6", high: "8", low: "6", close: "8", volumeNusd: "0", tradeCount: 1 },
  ];
  const snapshot = JSON.stringify(indexed);
  const result = mergeLiveTradesIntoCandles(indexed, [
    trade(121, "4", 0), trade(121, "2", 1), trade(241, "5", 2),
  ], 60, 10, "99");
  assert.equal(JSON.stringify(indexed), snapshot);
  const middle = result.find((candle) => candle.bucket === 120)!;
  assert.equal(middle.open, "3");
  assert.equal(middle.high, "4");
  assert.equal(middle.low, "2");
  assert.equal(middle.close, "2");
  assert.equal(middle.volumeNusd, "18014398509481986000");
  assert.equal(middle.tradeCount, 2);
  assert.equal(result.find((candle) => candle.bucket === 240)?.open, "2");
});

test("overlapping RPC and subgraph trades deduplicate by transaction and log index", () => {
  const live = trade(120, "2");
  const indexed = { ...live, txHash: live.txHash.toUpperCase() as PumpTrade["txHash"], priceNusd: "1" };
  const result = mergePumpTrades([live, trade(120, "3", 1)], [indexed]);
  assert.equal(result.length, 2);
  assert.equal(result[0].logIndex, 1);
  assert.equal(result[1].priceNusd, "2");
});
