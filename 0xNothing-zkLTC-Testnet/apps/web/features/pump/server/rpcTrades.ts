import "server-only";

import { formatUnits, getAddress, parseAbiItem, type Address } from "viem";
import { publicClient } from "@/lib/contract";
import { createBoundedCache } from "@/lib/boundedCache";
import {
  PUMP_FACTORY_ADDRESS,
  PUMP_START_BLOCK,
  ZERO_ADDRESS,
} from "@/features/pump/config";
import type { PumpTrade } from "@/features/pump/types";
import {
  LIVE_TAIL_CACHE_TTL_MS,
  MAX_BLOCK_TIMESTAMP_CACHE_ENTRIES,
  MAX_LIVE_TAIL_CACHE_ENTRIES,
  RPC_BLOCK_TIMESTAMP_CONCURRENCY,
  RPC_LOG_BLOCK_CHUNK,
  RPC_TRADE_LOG_CONCURRENCY,
  RPC_TRADE_LOOKBACK,
} from "./constants";
import { ZERO_HASH, mapWithConcurrency, safeNumber } from "./values";

/**
 * Trade history and the live head that is overlaid on indexed trades, read from
 * factory logs. History walks newest-first and stops as soon as the requested
 * page is filled; the live head is a known window and is fetched in parallel.
 */

const TOKEN_TRADED_EVENT = parseAbiItem(
  "event TokenTraded(address indexed token,address indexed trader,bool indexed isBuy,uint256 tokenAmount,uint256 curveNusdAmount,uint256 userNusdAmount,uint256 feeNusd,uint256 realNusdReserveAfter,uint256 tokenReserveAfter,uint256 virtualNusdReserveAfter,uint256 virtualTokenReserveAfter,uint256 circulatingSupplyAfter,uint256 spotPriceNusdWad,uint256 curveProgressBps)",
);

type LiveTail = { trades: PumpTrade[]; truncated: boolean };
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
  let chunkTo = latest;
  const needed = skip + limit;
  while (chunkTo >= fromBlock && newestFirst.length < needed) {
    const chunkFrom = chunkTo - fromBlock + 1n > RPC_LOG_BLOCK_CHUNK
      ? chunkTo - RPC_LOG_BLOCK_CHUNK + 1n
      : fromBlock;
    const chunk = await fetchPumpTradeLogChunk(token, chunkFrom, chunkTo, trader);
    newestFirst.push(...chunk.reverse());
    if (chunkFrom === fromBlock) break;
    chunkTo = chunkFrom - 1n;
  }
  const selected = newestFirst.slice(skip, skip + limit);
  return hydratePumpTradeLogs(selected);
}

export async function getRpcTradesAfterBlock(
  token: Address | undefined,
  indexedBlock: bigint,
  trader?: Address,
): Promise<{ trades: PumpTrade[]; truncated: boolean }> {
  const key = `${token?.toLowerCase() ?? "all"}:${trader?.toLowerCase() ?? "all"}:${indexedBlock}`;
  return liveTailCache.load(key, () => loadRpcTradesAfterBlock(token, indexedBlock, trader));
}

async function loadRpcTradesAfterBlock(
  token: Address | undefined,
  indexedBlock: bigint,
  trader?: Address,
): Promise<LiveTail> {
  const latest = await publicClient.getBlockNumber();
  if (indexedBlock >= latest) return { trades: [], truncated: false };

  const oldestRealtimeBlock = latest >= RPC_TRADE_LOOKBACK
    ? latest - RPC_TRADE_LOOKBACK + 1n
    : 0n;
  let chunkFrom = indexedBlock + 1n;
  const truncated = chunkFrom < oldestRealtimeBlock;
  if (truncated) chunkFrom = oldestRealtimeBlock;

  const logs: PumpTradeLog[] = [];
  const ranges: Array<{ fromBlock: bigint; toBlock: bigint }> = [];
  for (let rangeFrom = chunkFrom; rangeFrom <= latest; ) {
    const candidateTo = rangeFrom + RPC_LOG_BLOCK_CHUNK - 1n;
    const rangeTo = candidateTo < latest ? candidateTo : latest;
    ranges.push({ fromBlock: rangeFrom, toBlock: rangeTo });
    rangeFrom = rangeTo + 1n;
  }
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
  return publicClient.getLogs({
    address: PUMP_FACTORY_ADDRESS,
    event: TOKEN_TRADED_EVENT,
    args,
    fromBlock,
    toBlock,
  });
}

type PumpTradeLog = Awaited<ReturnType<typeof fetchPumpTradeLogChunk>>[number];
