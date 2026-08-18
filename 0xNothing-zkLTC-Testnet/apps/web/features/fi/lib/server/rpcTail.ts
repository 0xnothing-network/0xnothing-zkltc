import "server-only";

import { createPublicClient, formatUnits, http, parseAbiItem, type Address, type Hex } from "viem";
import { deployment } from "@fi/config/deployment";

const MAX_TAIL_BLOCKS = 5_000n;
const BLOCK_TIMESTAMP_CONCURRENCY = 16;
const PAIR_TAIL_CACHE_TTL_MS = 4_000;
const STATIC_RPC_CACHE_TTL_MS = 10 * 60_000;
const NEGATIVE_FACTORY_PAIR_CACHE_TTL_MS = 5_000;
const MAX_PAIR_TAIL_CACHE_ENTRIES = 64;
const MAX_BLOCK_TIMESTAMP_CACHE_ENTRIES = 2_048;
const MAX_PAIR_METADATA_CACHE_ENTRIES = 128;
const MAX_FACTORY_PAIR_CACHE_ENTRIES = 256;
const MAX_IN_FLIGHT_REQUESTS = 128;
const syncEvent = parseAbiItem("event Sync(uint112 reserve0, uint112 reserve1)");
const swapEvent = parseAbiItem(
  "event Swap(address indexed sender, uint256 amount0In, uint256 amount1In, uint256 amount0Out, uint256 amount1Out, address indexed to)",
);
const mintEvent = parseAbiItem(
  "event Mint(address indexed sender, uint256 amount0, uint256 amount1, address indexed to, uint256 liquidity)",
);
const burnEvent = parseAbiItem(
  "event Burn(address indexed sender, uint256 amount0, uint256 amount1, address indexed to, uint256 liquidity)",
);
const pairTokensAbi = [
  { type: "function", name: "token0", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "token1", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
] as const;
const tokenDecimalsAbi = [
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
] as const;

const client = createPublicClient({
  transport: http(deployment.chain.rpcUrl, {
    batch: { batchSize: 100, wait: 10 },
    retryCount: 2,
    retryDelay: 300,
    timeout: 15_000,
  }),
});

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

const pairTailCache = new Map<string, CacheEntry<PairTail>>();
const pairTailInFlight = new Map<string, Promise<PairTail>>();
const blockTimestampCache = new Map<string, CacheEntry<number>>();
const blockTimestampInFlight = new Map<string, Promise<number>>();
const pairMetadataCache = new Map<string, CacheEntry<PairTokenMetadata>>();
const pairMetadataInFlight = new Map<string, Promise<PairTokenMetadata>>();
const factoryPairCache = new Map<string, CacheEntry<boolean>>();
const factoryPairInFlight = new Map<string, Promise<boolean>>();

interface TailBase {
  blockNumber: bigint;
  logIndex: number;
  transactionHash: Hex;
  timestamp: number;
}

export type PairTailEvent = TailBase & (
  | { kind: "sync"; reserve0: bigint; reserve1: bigint }
  | { kind: "swap"; sender: Address; recipient: Address; amount0In: bigint; amount1In: bigint; amount0Out: bigint; amount1Out: bigint }
  | { kind: "mint"; sender: Address; recipient: Address; amount0: bigint; amount1: bigint; liquidity: bigint }
  | { kind: "burn"; sender: Address; recipient: Address; amount0: bigint; amount1: bigint; liquidity: bigint }
);

export interface PairTail {
  events: PairTailEvent[];
  requestedFromBlock: bigint;
  fromBlock: bigint;
  toBlock: bigint;
  capped: boolean;
}

function readCached<T>(cache: Map<string, CacheEntry<T>>, key: string): T | undefined {
  const entry = cache.get(key);
  if (!entry) return undefined;
  if (entry.expiresAt <= Date.now()) {
    cache.delete(key);
    return undefined;
  }
  // Refresh insertion order so the entry cap removes the least recently used value.
  cache.delete(key);
  cache.set(key, entry);
  return entry.value;
}

function writeCached<T>(cache: Map<string, CacheEntry<T>>, key: string, value: T, ttlMs: number, maxEntries: number): void {
  cache.delete(key);
  cache.set(key, { value, expiresAt: Date.now() + ttlMs });
  while (cache.size > maxEntries) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey === undefined) return;
    cache.delete(oldestKey);
  }
}

function required<T>(value: T | null | undefined, label: string): T {
  if (value === null || value === undefined) throw new Error(`RPC log is missing ${label}`);
  return value;
}

export async function loadPairTail(pool: Address, indexedBlock: number | null): Promise<PairTail> {
  const key = `${pool.toLowerCase()}:${indexedBlock === null ? "null" : indexedBlock}`;
  const cached = readCached(pairTailCache, key);
  if (cached) return cached;

  const pending = pairTailInFlight.get(key);
  if (pending) return pending;

  const request = loadPairTailFromRpc(pool, indexedBlock);
  if (pairTailInFlight.size < MAX_IN_FLIGHT_REQUESTS) {
    pairTailInFlight.set(key, request);
    void request.then(
      (tail) => writeCached(pairTailCache, key, tail, PAIR_TAIL_CACHE_TTL_MS, MAX_PAIR_TAIL_CACHE_ENTRIES),
      () => undefined,
    ).finally(() => pairTailInFlight.delete(key));
  }
  return request;
}

async function loadPairTailFromRpc(pool: Address, indexedBlock: number | null): Promise<PairTail> {
  const latest = await client.getBlockNumber();
  const deploymentBlock = BigInt(deployment.indexer.deploymentBlock || "0");
  const requestedFromBlock = indexedBlock === null ? deploymentBlock : BigInt(indexedBlock + 1);
  if (requestedFromBlock > latest) {
    return { events: [], requestedFromBlock, fromBlock: requestedFromBlock, toBlock: latest, capped: false };
  }
  const capped = latest - requestedFromBlock + 1n > MAX_TAIL_BLOCKS;
  const fromBlock = capped ? latest - MAX_TAIL_BLOCKS + 1n : requestedFromBlock;

  const [syncLogs, swapLogs, mintLogs, burnLogs] = await Promise.all([
    client.getLogs({ address: pool, event: syncEvent, fromBlock, toBlock: latest }),
    client.getLogs({ address: pool, event: swapEvent, fromBlock, toBlock: latest }),
    client.getLogs({ address: pool, event: mintEvent, fromBlock, toBlock: latest }),
    client.getLogs({ address: pool, event: burnEvent, fromBlock, toBlock: latest }),
  ]);

  const rawEvents = [
    ...syncLogs.map((log) => ({
      kind: "sync" as const,
      blockNumber: required(log.blockNumber, "block number"),
      logIndex: required(log.logIndex, "log index"),
      transactionHash: required(log.transactionHash, "transaction hash"),
      reserve0: required(log.args.reserve0, "reserve0"),
      reserve1: required(log.args.reserve1, "reserve1"),
    })),
    ...swapLogs.map((log) => ({
      kind: "swap" as const,
      blockNumber: required(log.blockNumber, "block number"),
      logIndex: required(log.logIndex, "log index"),
      transactionHash: required(log.transactionHash, "transaction hash"),
      sender: required(log.args.sender, "sender"),
      recipient: required(log.args.to, "recipient"),
      amount0In: required(log.args.amount0In, "amount0In"),
      amount1In: required(log.args.amount1In, "amount1In"),
      amount0Out: required(log.args.amount0Out, "amount0Out"),
      amount1Out: required(log.args.amount1Out, "amount1Out"),
    })),
    ...mintLogs.map((log) => ({
      kind: "mint" as const,
      blockNumber: required(log.blockNumber, "block number"),
      logIndex: required(log.logIndex, "log index"),
      transactionHash: required(log.transactionHash, "transaction hash"),
      sender: required(log.args.sender, "sender"),
      recipient: required(log.args.to, "recipient"),
      amount0: required(log.args.amount0, "amount0"),
      amount1: required(log.args.amount1, "amount1"),
      liquidity: required(log.args.liquidity, "liquidity"),
    })),
    ...burnLogs.map((log) => ({
      kind: "burn" as const,
      blockNumber: required(log.blockNumber, "block number"),
      logIndex: required(log.logIndex, "log index"),
      transactionHash: required(log.transactionHash, "transaction hash"),
      sender: required(log.args.sender, "sender"),
      recipient: required(log.args.to, "recipient"),
      amount0: required(log.args.amount0, "amount0"),
      amount1: required(log.args.amount1, "amount1"),
      liquidity: required(log.args.liquidity, "liquidity"),
    })),
  ].sort((a, b) => a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : a.blockNumber < b.blockNumber ? -1 : 1);

  const blockNumbers = [...new Set(rawEvents.map((event) => event.blockNumber.toString()))];
  const timestamps = new Map<string, number>();
  await mapWithConcurrency(blockNumbers, BLOCK_TIMESTAMP_CONCURRENCY, async (blockNumber) => {
    timestamps.set(blockNumber, await loadBlockTimestamp(blockNumber));
  });
  const events = rawEvents.map((event) => ({
    ...event,
    timestamp: timestamps.get(event.blockNumber.toString()) || 0,
  })) as PairTailEvent[];
  return { events, requestedFromBlock, fromBlock, toBlock: latest, capped };
}

async function loadBlockTimestamp(blockNumber: string): Promise<number> {
  const cached = readCached(blockTimestampCache, blockNumber);
  if (cached !== undefined) return cached;

  const pending = blockTimestampInFlight.get(blockNumber);
  if (pending) return pending;

  const request = client.getBlock({ blockNumber: BigInt(blockNumber) }).then((block) => Number(block.timestamp));
  if (blockTimestampInFlight.size < MAX_IN_FLIGHT_REQUESTS) {
    blockTimestampInFlight.set(blockNumber, request);
    void request.then(
      (timestamp) => writeCached(blockTimestampCache, blockNumber, timestamp, STATIC_RPC_CACHE_TTL_MS, MAX_BLOCK_TIMESTAMP_CACHE_ENTRIES),
      () => undefined,
    ).finally(() => blockTimestampInFlight.delete(blockNumber));
  }
  return request;
}

async function mapWithConcurrency<T>(
  items: T[],
  concurrency: number,
  mapper: (item: T) => Promise<void>,
): Promise<void> {
  let nextIndex = 0;
  await Promise.all(
    Array.from({ length: Math.min(Math.max(1, concurrency), items.length) }, async () => {
      while (true) {
        const index = nextIndex++;
        if (index >= items.length) return;
        await mapper(items[index]);
      }
    }),
  );
}

export interface PairTokenMetadata {
  token0: Address;
  token1: Address;
  decimals0: number;
  decimals1: number;
}

export async function pairTokenMetadata(pool: Address): Promise<PairTokenMetadata> {
  const key = pool.toLowerCase();
  const cached = readCached(pairMetadataCache, key);
  if (cached) return cached;

  const pending = pairMetadataInFlight.get(key);
  if (pending) return pending;

  const request = loadPairTokenMetadata(pool);
  if (pairMetadataInFlight.size < MAX_IN_FLIGHT_REQUESTS) {
    pairMetadataInFlight.set(key, request);
    void request.then(
      (metadata) => writeCached(pairMetadataCache, key, metadata, STATIC_RPC_CACHE_TTL_MS, MAX_PAIR_METADATA_CACHE_ENTRIES),
      () => undefined,
    ).finally(() => pairMetadataInFlight.delete(key));
  }
  return request;
}

async function loadPairTokenMetadata(pool: Address): Promise<PairTokenMetadata> {
  const [token0, token1] = await Promise.all([
    client.readContract({ address: pool, abi: pairTokensAbi, functionName: "token0" }),
    client.readContract({ address: pool, abi: pairTokensAbi, functionName: "token1" }),
  ]);
  const [decimals0, decimals1] = await Promise.all([
    client.readContract({ address: token0, abi: tokenDecimalsAbi, functionName: "decimals" }).catch(() => 18),
    client.readContract({ address: token1, abi: tokenDecimalsAbi, functionName: "decimals" }).catch(() => 18),
  ]);
  return { token0, token1, decimals0, decimals1 };
}

export async function pairForTokens(factory?: Address, tokenA?: Address, tokenB?: Address): Promise<Address | undefined> {
  if (!factory || !tokenA || !tokenB) return undefined;
  const pair = await client.readContract({
    address: factory,
    abi: [{
      type: "function", name: "getPair", stateMutability: "view",
      inputs: [{ name: "tokenA", type: "address" }, { name: "tokenB", type: "address" }],
      outputs: [{ name: "pair", type: "address" }],
    }],
    functionName: "getPair",
    args: [tokenA, tokenB],
  });
  return pair === "0x0000000000000000000000000000000000000000" ? undefined : pair;
}

export async function isFactoryPair(factory: Address | undefined, candidate: Address): Promise<boolean> {
  if (!factory) return false;
  const key = `${factory.toLowerCase()}:${candidate.toLowerCase()}`;
  const cached = readCached(factoryPairCache, key);
  if (cached !== undefined) return cached;

  const pending = factoryPairInFlight.get(key);
  if (pending) return pending;

  const request = client.readContract({
    address: factory,
    abi: [{
      type: "function", name: "isPair", stateMutability: "view",
      inputs: [{ name: "candidate", type: "address" }],
      outputs: [{ name: "", type: "bool" }],
    }],
    functionName: "isPair",
    args: [candidate],
  });
  if (factoryPairInFlight.size < MAX_IN_FLIGHT_REQUESTS) {
    factoryPairInFlight.set(key, request);
    void request.then(
      (isPair) => writeCached(
        factoryPairCache,
        key,
        isPair,
        isPair ? STATIC_RPC_CACHE_TTL_MS : NEGATIVE_FACTORY_PAIR_CACHE_TTL_MS,
        MAX_FACTORY_PAIR_CACHE_ENTRIES,
      ),
      () => undefined,
    ).finally(() => factoryPairInFlight.delete(key));
  }
  return request;
}

export function decimal(value: bigint, decimals = 18): number {
  const parsed = Number(formatUnits(value, decimals));
  return Number.isFinite(parsed) ? parsed : 0;
}
