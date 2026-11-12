import "server-only";

import { formatUnits, getAddress, parseAbiItem, type Address } from "viem";
import { publicClient, scanLogsClient } from "@/lib/contract";
import { logRanges } from "@/lib/logRanges";
import { createBoundedCache } from "@/lib/boundedCache";
import {
  PUMP_FACTORY_ADDRESS,
  PUMP_START_BLOCK,
  ZERO_ADDRESS,
} from "@/features/pump/config";
import type { PumpTrade } from "@/features/pump/types";
import {
  LIVE_TAIL_CACHE_TTL_MS,
  LIVE_TAIL_WIDE_SCAN_RANGES,
  LIVE_TAIL_WIDE_SCAN_TTL_MS,
  MAX_BLOCK_TIMESTAMP_CACHE_ENTRIES,
  MAX_LIVE_TAIL_CACHE_ENTRIES,
  RPC_BLOCK_TIMESTAMP_CONCURRENCY,
  RPC_SCAN_DEADLINE_MS,
  RPC_TRADE_LOG_CONCURRENCY,
  RPC_TRADE_LOOKBACK,
} from "./constants";
import { ZERO_HASH, mapWithConcurrency, safeNumber } from "./values";

/**
 * Trade history and the live head that is overlaid on indexed trades, read from
 * factory logs. History walks 2,000-block windows newest-first and stops as soon
 * as the requested page is filled or its deadline passes; the live head is a known
 * window and is fetched in parallel.
 */

const TOKEN_TRADED_EVENT = parseAbiItem(
  "event TokenTraded(address indexed token,address indexed trader,bool indexed isBuy,uint256 tokenAmount,uint256 curveNusdAmount,uint256 userNusdAmount,uint256 feeNusd,uint256 realNusdReserveAfter,uint256 tokenReserveAfter,uint256 virtualNusdReserveAfter,uint256 virtualTokenReserveAfter,uint256 circulatingSupplyAfter,uint256 spotPriceNusdWad,uint256 curveProgressBps)",
);

type LiveTail = { trades: PumpTrade[]; truncated: boolean; scannedRanges: number };
const liveTailCache = createBoundedCache<LiveTail>({
  maxEntries: MAX_LIVE_TAIL_CACHE_ENTRIES,
  ttlMs: LIVE_TAIL_CACHE_TTL_MS,
  maxInFlight: MAX_LIVE_TAIL_CACHE_ENTRIES,
});
// A mined block's timestamp never changes, so entries stay valid until the entry
// cap evicts them.
const blockTimestampCache = createBoundedCache<number>({
  maxEntries: MAX_BLOCK_TIMESTAMP_CACHE_ENTRIES,
  maxInFlight: MAX_BLOCK_TIMESTAMP_CACHE_ENTRIES,
});

export async function getRpcTrades(
  token: Address | undefined,
  limit: number,
  skip: number,
  maxLookbackBlocks?: bigint,
  trader?: Address,
): Promise<PumpTrade[]> {
  const latest = await publicClient.getBlockNumber();
  const deploymentBlock = PUMP_START_BLOCK > 0n ? PUMP_START_BLOCK : 0n;
  const lookbackBlock = maxLookbackBlocks !== undefined && latest > maxLookbackBlocks
    ? latest - maxLookbackBlocks
    : 0n;
  const fromBlock = deploymentBlock > lookbackBlock ? deploymentBlock : lookbackBlock;
  const newestFirst: PumpTradeLog[] = [];
  const needed = skip + limit;
  const ranges = logRanges(fromBlock, latest).reverse();
  const startedAt = Date.now();
  for (let start = 0; start < ranges.length && newestFirst.length < needed; start += RPC_TRADE_LOG_CONCURRENCY) {
    if (start > 0 && Date.now() - startedAt >= RPC_SCAN_DEADLINE_MS) break;
    const pages = await Promise.allSettled(
      ranges.slice(start, start + RPC_TRADE_LOG_CONCURRENCY).map((range) =>
        fetchPumpTradeLogChunk(token, range.fromBlock, range.toBlock, trader)),
    );
    let failed: PromiseRejectedResult | undefined;
    for (const page of pages) {
      // History must stay contiguous from the newest block, so it ends at the first
      // window that could not be read instead of skipping over it.
      if (page.status !== "fulfilled") { failed = page; break; }
      newestFirst.push(...page.value.reverse());
    }
    if (failed) {
      // Nothing read at all is an outage, not a short history.
      if (start === 0 && failed === pages[0]) throw failed.reason;
      break;
    }
  }
  const selected = newestFirst.slice(skip, skip + limit);
  return hydratePumpTradeLogs(selected);
}

const LIVE_TAIL_DEADLINE_MS = 4_000;

export async function getRpcTradesAfterBlock(
  token: Address | undefined,
  indexedBlock: bigint,
  trader?: Address,
): Promise<{ trades: PumpTrade[]; truncated: boolean }> {
  const key = `${token?.toLowerCase() ?? "all"}:${trader?.toLowerCase() ?? "all"}:${indexedBlock}`;
  // A tail that spans many log windows (the index is far behind) costs that many RPC
  // calls each time, so it is reused for longer than a short one.
  const tail = liveTailCache.load(
    key,
    () => loadRpcTradesAfterBlock(token, indexedBlock, trader),
    (loaded) => loaded.scannedRanges > LIVE_TAIL_WIDE_SCAN_RANGES ? LIVE_TAIL_WIDE_SCAN_TTL_MS : LIVE_TAIL_CACHE_TTL_MS,
  );
  // The live tail is optional: callers keep their indexed data and show a delay
  // warning. A slow log backend must not hold the response through its retries;
  // the scan keeps running and a later poll picks it up from the cache.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("Live trade tail timed out")), LIVE_TAIL_DEADLINE_MS);
  });
  return Promise.race([tail, deadline]).finally(() => clearTimeout(timer));
}

async function loadRpcTradesAfterBlock(
  token: Address | undefined,
  indexedBlock: bigint,
  trader?: Address,
): Promise<LiveTail> {
  const latest = await publicClient.getBlockNumber();
  if (indexedBlock >= latest) return { trades: [], truncated: false, scannedRanges: 0 };

  const oldestRealtimeBlock = latest >= RPC_TRADE_LOOKBACK
    ? latest - RPC_TRADE_LOOKBACK + 1n
    : 0n;
  let chunkFrom = indexedBlock + 1n;
  const truncated = chunkFrom < oldestRealtimeBlock;
  if (truncated) chunkFrom = oldestRealtimeBlock;

  const logs: PumpTradeLog[] = [];
  const ranges = logRanges(chunkFrom, latest);
  // The whole live window is known up front, so the chunks do not have to be
  // walked one round-trip at a time the way the newest-first history scan does.
  // mapWithConcurrency fills a positional array, so appending the pages in
  // order preserves the canonical block/log ordering the candle merge relies on.
  const pages = await mapWithConcurrency(ranges, RPC_TRADE_LOG_CONCURRENCY, (range) =>
    fetchPumpTradeLogChunk(token, range.fromBlock, range.toBlock, trader));
  for (const page of pages) logs.push(...page);

  return {
    trades: await hydratePumpTradeLogs(logs),
    truncated,
    scannedRanges: ranges.length,
  };
}

async function hydratePumpTradeLogs(logs: PumpTradeLog[]): Promise<PumpTrade[]> {
  const blockNumbers = [...new Set(logs.map((log) => log.blockNumber.toString()))];
  const timestamps = new Map<string, number>();
  await mapWithConcurrency(blockNumbers, RPC_BLOCK_TIMESTAMP_CONCURRENCY, async (blockNumber) => {
    timestamps.set(blockNumber, await getBlockTimestamp(blockNumber));
  });

  return logs.map((log) => {
    const args = log.args;
    const tokenAddress = args.token ? getAddress(args.token) : ZERO_ADDRESS;
    return {
      id: `${log.transactionHash ?? ZERO_HASH}-${log.logIndex ?? 0}`,
      marketAddress: tokenAddress,
      tokenAddress,
      trader: args.trader ? getAddress(args.trader) : ZERO_ADDRESS,
      side: args.isBuy ? "BUY" : "SELL",
      nusdAmount: (args.curveNusdAmount ?? 0n).toString(),
      userNusdAmount: (args.userNusdAmount ?? 0n).toString(),
      tokenAmount: (args.tokenAmount ?? 0n).toString(),
      feeNusd: (args.feeNusd ?? 0n).toString(),
      priceNusd: formatUnits(args.spotPriceNusdWad ?? 0n, 18),
      timestamp: timestamps.get(log.blockNumber.toString()) ?? 0,
      blockNumber: safeNumber(log.blockNumber),
      logIndex: Number(log.logIndex ?? 0),
      txHash: log.transactionHash ?? ZERO_HASH,
    };
  });
}

async function getBlockTimestamp(blockNumber: string): Promise<number> {
  return blockTimestampCache.load(
    blockNumber,
    () => publicClient.getBlock({ blockNumber: BigInt(blockNumber) }).then((block) => safeNumber(block.timestamp)),
  );
}

async function fetchPumpTradeLogChunk(
  token: Address | undefined,
  fromBlock: bigint,
  toBlock: bigint,
  trader?: Address,
) {
  const args = token && trader
    ? { token, trader }
    : token
      ? { token }
      : trader
        ? { trader }
        : undefined;
  const read = () => scanLogsClient.getLogs({
    address: PUMP_FACTORY_ADDRESS,
    event: TOKEN_TRADED_EVENT,
    args,
    fromBlock,
    toBlock,
  });
  // The scan client does not retry, and a history walk ends at its first unread
  // window. One second try keeps a single dropped request from cutting it short.
  return read().catch(read);
}

type PumpTradeLog = Awaited<ReturnType<typeof fetchPumpTradeLogChunk>>[number];
