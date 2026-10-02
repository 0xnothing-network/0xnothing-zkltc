import { PIXEL_COLLECTIONS, isPixelCollection, pixelTokenKey } from "@/lib/pixelCollections";
import {
  decodeAbiParameters,
  createPublicClient,
  http,
  keccak256,
  toBytes,
  type Hex,
} from "viem";
import { PixelNFTABI } from "@/lib/abi";
import { MarketplaceAbi } from "@/lib/marketplaceAbi";
import {
  LITVM_EXPLORER_URL,
  PIXEL_MARKETPLACE_ADDRESS,
  PIXEL_NFT_CONTRACT_ADDRESS,
  publicClient,
} from "@/lib/contract";
import { getPixelImageUrl } from "@/lib/pixelImage";
import { createBoundedCache } from "@/lib/boundedCache";
import { readLimitedJson } from "@/lib/server/readLimitedJson";
import {
  MARKETPLACE_START_BLOCK as PUBLIC_MARKETPLACE_START_BLOCK,
  LITVM_RPC_URL,
} from "@/lib/publicConfig";
import type {
  SubgraphMarketEventDTO,
  SubgraphMarketEventType,
  SubgraphTokenMetadata,
} from "@/lib/marketplaceSubgraph";

const MARKETPLACE_START_BLOCK = PUBLIC_MARKETPLACE_START_BLOCK;
const EXPLORER_PAGE_SIZE = 1_000;
const EXPLORER_MAX_RANGES = 64;
const EXPLORER_TIMEOUT_MS = 8_000;
const MAX_EXPLORER_RESPONSE_BYTES = 8 * 1024 * 1024;
const RAW_CACHE_TTL_MS = 3_000;
const TOKEN_CACHE_TTL_MS = 60_000;
const MAX_TOKEN_CACHE_ENTRIES = 4_096;
const RPC_LOG_BLOCK_RANGE = 500n;
const RPC_LOG_MAX_REQUESTS = 32;
const RPC_LOG_RESULT_CAP = 1_000;
const RPC_LOG_LOOKBACK_BLOCKS = 5_000n;
const RPC_LOG_BACKFILL_BLOCKS = 1_000n;
const RPC_REORG_OVERLAP_BLOCKS = 64n;
const RPC_SCAN_MAX_MS = 12_000;
const MAX_RPC_LOGS_PER_FILTER = 10_000;
const RAW_EVENTS_CACHE_KEY = "marketplace-raw-events";

const EVENT_TOPICS = {
  minted: eventTopic("Minted(address,uint256,string)"),
  listed: eventTopic("Listed(uint256,address,uint256,address,uint256)"),
  bought: eventTopic("Bought(uint256,address,uint256)"),
  cancelled: eventTopic("ListingCancelled(uint256)"),
  invalidated: eventTopic("ListingInvalidated(uint256)"),
} as const;

interface ExplorerLog {
  blockNumber: string;
  data: Hex;
  logIndex: string;
  timeStamp: string;
  topics: Array<Hex | null>;
  transactionHash: Hex;
}

interface ExplorerLogsResponse {
  message?: string;
  result?: ExplorerLog[] | string;
  status?: string;
}

interface RpcActivityLog {
  address: string;
  blockNumber: Hex | null;
  transactionHash: Hex | null;
  logIndex: Hex | null;
  data: Hex;
  topics: Hex[];
  removed?: boolean;
}

interface ListingContext {
  collection: `0x${string}`;
  listingId: string;
  tokenId: string;
  price: string;
  seller: `0x${string}`;
}

interface ActivityLogWindow { logs: ExplorerLog[]; partialHistory: boolean }
interface ActivityWindow { events: SubgraphMarketEventDTO[]; partialHistory: boolean }
interface RpcActivityCheckpoint { head: bigint; oldest: bigint; logs: ExplorerLog[]; truncated: boolean }

const rpcActivityCheckpoints = createBoundedCache<RpcActivityCheckpoint>({ maxEntries: 16 });
const listingContextCache = createBoundedCache<ListingContext | null>({ maxEntries: 2_048, ttlMs: 60_000 });
const rawEventsCache = createBoundedCache<ActivityWindow>({
  maxEntries: 1,
  ttlMs: RAW_CACHE_TTL_MS,
});
const tokenCache = createBoundedCache<SubgraphTokenMetadata | null>({
  maxEntries: MAX_TOKEN_CACHE_ENTRIES,
  ttlMs: TOKEN_CACHE_TTL_MS,
});
const blockTimestampCache = createBoundedCache<number>({ maxEntries: 512, ttlMs: 60_000 });
// Historical log scans must not join the app client's JSON-RPC batches: six
// expensive filters in one request can time out together and hide fresh mints.
const activityRpcClient = createPublicClient({ transport: http(LITVM_RPC_URL, { batch: false, timeout: 8_000, retryCount: 0 }) });
let activeActivityRpc = 0;
const activityRpcWaiters: Array<() => void> = [];

async function withActivityRpc<T>(read: () => Promise<T>): Promise<T> {
  if (activeActivityRpc >= 3) await new Promise<void>((resolve) => activityRpcWaiters.push(resolve));
  else activeActivityRpc++;
  try { return await read(); }
  finally {
    const next = activityRpcWaiters.shift();
    if (next) next();
    else activeActivityRpc--;
  }
}

export async function fetchMarketplaceActivityFromOnchain({
  limit = 30,
  skip = 0,
  eventTypes,
}: {
  limit?: number;
  skip?: number;
  eventTypes?: SubgraphMarketEventType[];
} = {}): Promise<ActivityWindow> {
  const safeLimit = Math.min(Math.max(1, Math.floor(limit)), 100);
  const safeSkip = Math.max(0, Math.floor(skip));
  const allowedTypes = eventTypes?.length ? new Set(eventTypes) : null;
  const rawEvents = await loadRawEvents();
  const page = rawEvents.events
    .filter((event) => !allowedTypes || allowedTypes.has(event.eventType))
    .slice(safeSkip, safeSkip + safeLimit);

  const batches = await Promise.all(PIXEL_COLLECTIONS.map(async (collection) => {
    const tokenIds = Array.from(new Set(page.filter((event) => (event.collection ?? PIXEL_NFT_CONTRACT_ADDRESS).toLowerCase() === collection.address.toLowerCase()).map((event) => event.tokenId).filter((id) => id !== "0")));
    const metadata = await fetchTokenMetadata(tokenIds, collection.address);
    return Object.fromEntries(Object.entries(metadata).map(([id, value]) => [pixelTokenKey(collection.address, id), value]));
  }));
  const metadata = Object.assign({}, ...batches) as Record<string, SubgraphTokenMetadata | null>;
  return { events: page.map((event) => ({ ...event, token: metadata[pixelTokenKey(event.collection ?? PIXEL_NFT_CONTRACT_ADDRESS, event.tokenId)] ?? event.token })), partialHistory: rawEvents.partialHistory };

}

async function loadRawEvents(): Promise<ActivityWindow> {
  return rawEventsCache.load(RAW_EVENTS_CACHE_KEY, loadRawEventsUncached);
}

async function loadRawEventsUncached(): Promise<ActivityWindow> {
  const latestBlock = await publicClient.getBlockNumber();
  const [mintedWindows, listedWindow, boughtWindow, cancelledWindow, invalidatedWindow] =
    await Promise.all([
      Promise.all(PIXEL_COLLECTIONS.map(async (collection) => {
        const window = await fetchActivityLogs(collection.address, collection.startBlock, latestBlock, EVENT_TOPICS.minted);
        return { events: window.logs.map((log) => parseMintedLog(log, collection.address)).filter(isPresent), partialHistory: window.partialHistory };
      })),
      fetchActivityLogs(
        PIXEL_MARKETPLACE_ADDRESS,
        MARKETPLACE_START_BLOCK,
        latestBlock,
        EVENT_TOPICS.listed
      ),
      fetchActivityLogs(
        PIXEL_MARKETPLACE_ADDRESS,
        MARKETPLACE_START_BLOCK,
        latestBlock,
        EVENT_TOPICS.bought
      ),
      fetchActivityLogs(
        PIXEL_MARKETPLACE_ADDRESS,
        MARKETPLACE_START_BLOCK,
        latestBlock,
        EVENT_TOPICS.cancelled
      ),
      fetchActivityLogs(
        PIXEL_MARKETPLACE_ADDRESS,
        MARKETPLACE_START_BLOCK,
        latestBlock,
        EVENT_TOPICS.invalidated
      ),
    ]);

  const mintedEvents = mintedWindows.flatMap((window) => window.events);
  let partialHistory = mintedWindows.some((window) => window.partialHistory)
    || [listedWindow, boughtWindow, cancelledWindow, invalidatedWindow].some((window) => window.partialHistory);
  const mintedByToken = new Map(
    mintedEvents.map((event) => [pixelTokenKey(event.collection ?? PIXEL_NFT_CONTRACT_ADDRESS, event.tokenId), event.token] as const)
  );
  const listings = new Map<string, ListingContext>();
  const marketEvents: SubgraphMarketEventDTO[] = [];

  for (const log of listedWindow.logs) {
    const parsed = parseListedLog(log);
    if (!parsed) continue;
    listings.set(parsed.context.listingId, parsed.context);
    marketEvents.push({
      ...parsed.event,
      token: mintedByToken.get(pixelTokenKey(parsed.event.collection ?? PIXEL_NFT_CONTRACT_ADDRESS, parsed.event.tokenId)) ?? null,
    });
  }

  // A buy/cancel can be recent while its original Listed event predates the
  // bounded scan. The immutable listing tuple still carries its NFT identity.
  const missingIds = Array.from(new Set([...boughtWindow.logs, ...cancelledWindow.logs, ...invalidatedWindow.logs]
    .sort((a, b) => parseRpcNumber(b.blockNumber) - parseRpcNumber(a.blockNumber))
    .map((log) => uintFromTopic(log.topics[1])?.toString()).filter((id): id is string => Boolean(id))))
    .filter((id) => !listings.has(id));
  if (missingIds.length > 100) partialHistory = true;
  const contextDeadline = Date.now() + 10_000;
  await Promise.all(missingIds.slice(0, 100).map(async (listingId) => {
    try {
      const context = await listingContextCache.load(listingId, async () => {
        const [collection, tokenId, price, seller] = await withActivityRpc(() => {
          if (Date.now() >= contextDeadline) throw new Error("Activity context read budget exceeded");
          return activityRpcClient.readContract({ address: PIXEL_MARKETPLACE_ADDRESS, abi: MarketplaceAbi,
            functionName: "listings", args: [BigInt(listingId)] });
        });
        if (!isPixelCollection(collection) || /^0x0{40}$/i.test(seller)) return null;
        return { listingId, collection: collection.toLowerCase() as `0x${string}`, tokenId: tokenId.toString(),
          price: price.toString(), seller: seller.toLowerCase() as `0x${string}` };
      }, (value) => value ? 60_000 : 3_000);
      if (context) listings.set(listingId, context);
    } catch (error) {
      partialHistory = true;
      console.warn("[marketplace] listing activity context unavailable:", error);
    }
  }));

  for (const log of boughtWindow.logs) {
    const parsed = parseBoughtLog(log, listings);
    if (!parsed) continue;
    marketEvents.push({
      ...parsed,
      token: mintedByToken.get(pixelTokenKey(parsed.collection ?? PIXEL_NFT_CONTRACT_ADDRESS, parsed.tokenId)) ?? null,
    });
  }

  for (const log of [...cancelledWindow.logs, ...invalidatedWindow.logs]) {
    const parsed = parseCancelledLog(log, listings);
    if (!parsed) continue;
    marketEvents.push({
      ...parsed,
      token: mintedByToken.get(pixelTokenKey(parsed.collection ?? PIXEL_NFT_CONTRACT_ADDRESS, parsed.tokenId)) ?? null,
    });
  }

  return { partialHistory, events: [...marketEvents, ...mintedEvents].sort(
    (a, b) =>
      b.timestamp - a.timestamp ||
      b.blockNumber - a.blockNumber ||
      b.id.localeCompare(a.id)
  ) };
}

/** New deployments must remain visible while the explorer is behind the chain. */
async function fetchActivityLogs(address: `0x${string}`, fromBlock: bigint, toBlock: bigint, topic0: Hex): Promise<ActivityLogWindow> {
  if (fromBlock > toBlock) return { logs: [], partialHistory: false };
  const v2 = PIXEL_COLLECTIONS.find((collection) => collection.version === 2);
  if (!v2) return { logs: await fetchExplorerLogs(address, fromBlock, toBlock, topic0), partialHistory: false };
  const rpcStart = fromBlock > v2.startBlock ? fromBlock : v2.startBlock;
  if (address.toLowerCase() === v2.address.toLowerCase()) {
    return fetchRpcActivityLogs(address, rpcStart, toBlock, topic0);
  }
  const [historical, recent] = await Promise.all([
    fetchExplorerLogs(address, fromBlock, toBlock, topic0).catch((error) => {
      console.warn("[marketplace] explorer history unavailable; retaining RPC activity:", error);
      return null;
    }),
    fetchRpcActivityLogs(address, rpcStart, toBlock, topic0),
  ]);
  // RPC wins when the same event is already present in the explorer response.
  return { logs: Array.from(new Map([...(historical ?? []), ...recent.logs].map((log) => [eventId(log), log])).values()),
    partialHistory: historical === null || recent.partialHistory };
}

async function fetchRpcActivityLogs(address: `0x${string}`, fromBlock: bigint, toBlock: bigint, topic0: Hex): Promise<ActivityLogWindow> {
  if (fromBlock > toBlock) return { logs: [], partialHistory: false };
  const key = `${address.toLowerCase()}:${topic0.toLowerCase()}:${fromBlock}`;
  const cached = rpcActivityCheckpoints.get(key);
  // A head rewind invalidates the checkpoint. Normal refreshes replace the
  // overlapping head range so removed/reorganized logs cannot remain cached.
  const prior = cached && cached.head <= toBlock ? cached : undefined;
  const minimumRecent = toBlock - RPC_LOG_LOOKBACK_BLOCKS + 1n;
  const resumed = prior ? prior.head - RPC_REORG_OVERLAP_BLOCKS + 1n : minimumRecent;
  const recentStart = [fromBlock, minimumRecent, resumed].reduce((highest, value) => value > highest ? value : highest);
  const recent = await scanRpcActivityRange(address, recentStart, toBlock, topic0);
  let oldest = prior?.oldest ?? recentStart;
  let truncated = prior?.truncated ?? false;
  if (prior && recentStart > prior.head + 1n) truncated = true;
  const previous = (prior?.logs ?? []).filter((log) => BigInt(log.blockNumber) < recentStart);
  let backfill: ExplorerLog[] = [];
  if (prior && oldest > fromBlock) {
    const backfillStart = oldest - RPC_LOG_BACKFILL_BLOCKS > fromBlock ? oldest - RPC_LOG_BACKFILL_BLOCKS : fromBlock;
    try {
      const older = await scanRpcActivityRange(address, backfillStart, oldest - 1n, topic0);
      backfill = older.logs;
      if (!older.partialHistory) oldest = backfillStart;
    } catch (error) {
      // Older data is optional while the fresh head remains usable.
      console.warn("[marketplace] earlier RPC activity unavailable:", error);
    }
  }
  const all = Array.from(new Map([...previous, ...backfill, ...recent.logs].map((log) => [eventId(log), log])).values())
    .sort((a, b) => {
      const blockOrder = BigInt(b.blockNumber) - BigInt(a.blockNumber);
      return blockOrder === 0n ? Number(BigInt(b.logIndex) - BigInt(a.logIndex)) : blockOrder > 0n ? 1 : -1;
    });
  truncated ||= all.length > MAX_RPC_LOGS_PER_FILTER;
  const retained = all.slice(0, MAX_RPC_LOGS_PER_FILTER);
  // A partial head scan is retried from the previous checkpoint on the next
  // refresh; do not permanently skip the ranges that exceeded this request.
  if (!recent.partialHistory) rpcActivityCheckpoints.set(key, { head: toBlock, oldest, logs: retained, truncated });
  return { logs: retained, partialHistory: recent.partialHistory || truncated || oldest > fromBlock };
}

async function scanRpcActivityRange(address: `0x${string}`, fromBlock: bigint, toBlock: bigint, topic0: Hex): Promise<ActivityLogWindow> {
  const ranges: Array<readonly [bigint, bigint]> = [[fromBlock, toBlock]];
  const logs: RpcActivityLog[] = [];
  let requests = 0;
  let completedRanges = 0;
  const deadline = Date.now() + RPC_SCAN_MAX_MS;
  let partialHistory = false;
  while (ranges.length) {
    const [start, end] = ranges.pop()!;
    if (end - start + 1n > RPC_LOG_BLOCK_RANGE) {
      const boundary = end - RPC_LOG_BLOCK_RANGE + 1n;
      ranges.push([start, boundary - 1n], [boundary, end]);
      continue;
    }
    if (++requests > RPC_LOG_MAX_REQUESTS || Date.now() >= deadline) { partialHistory = true; break; }
    let result: RpcActivityLog[];
    try {
      result = await withActivityRpc(() => activityRpcClient.request({ method: "eth_getLogs", params: [{ address, fromBlock: `0x${start.toString(16)}`, toBlock: `0x${end.toString(16)}`, topics: [topic0] }] })) as RpcActivityLog[];
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (start === end || !/range|too many|limit exceeded|response size|result.*limit|more than|timeout|timed\s*out/i.test(message)) {
        if (!completedRanges) throw error;
        partialHistory = true;
        console.warn("[marketplace] earlier activity range unavailable; retaining recent logs:", error);
        break;
      }
      const midpoint = (start + end) / 2n;
      ranges.push([start, midpoint], [midpoint + 1n, end]);
      continue;
    }
    if (result.length >= RPC_LOG_RESULT_CAP) {
      if (start === end) throw new Error("RPC activity result cap exceeded in one block");
      const midpoint = (start + end) / 2n;
      ranges.push([start, midpoint], [midpoint + 1n, end]);
      continue;
    }
    completedRanges++;
    logs.push(...result.filter((log) => !log.removed && log.address.toLowerCase() === address.toLowerCase()
      && log.topics[0]?.toLowerCase() === topic0.toLowerCase() && log.blockNumber !== null && log.transactionHash !== null && log.logIndex !== null));
  }
  const unique = Array.from(new Map(logs.map((log) => [`${log.transactionHash!.toLowerCase()}:${BigInt(log.logIndex!)}`, log])).values());
  return { partialHistory, logs: await Promise.all(unique.map(async (log) => {
    const blockNumber = BigInt(log.blockNumber!);
    const timestamp = await blockTimestampCache.load(blockNumber.toString(), async () => {
      const block = await withActivityRpc(() => activityRpcClient.getBlock({ blockNumber }));
      return Number(block.timestamp);
    });
    return { blockNumber: log.blockNumber!, transactionHash: log.transactionHash!, logIndex: log.logIndex!, data: log.data, topics: log.topics, timeStamp: timestamp.toString() };
  })) };
}

async function fetchExplorerLogs(
  address: `0x${string}`,
  fromBlock: bigint,
  toBlock: bigint,
  topic0: Hex
): Promise<ExplorerLog[]> {
  const logs: ExplorerLog[] = [];
  const ranges: Array<readonly [bigint, bigint]> = [[fromBlock, toBlock]];
  let processedRanges = 0;

  while (ranges.length > 0) {
    if (processedRanges >= EXPLORER_MAX_RANGES) {
      throw new Error("Explorer activity range limit exceeded");
    }
    processedRanges += 1;
    const [rangeStart, rangeEnd] = ranges.pop()!;
    const url = new URL(`${LITVM_EXPLORER_URL.replace(/\/$/, "")}/api`);
    url.searchParams.set("module", "logs");
    url.searchParams.set("action", "getLogs");
    url.searchParams.set("fromBlock", rangeStart.toString());
    url.searchParams.set("toBlock", rangeEnd.toString());
    url.searchParams.set("address", address);
    url.searchParams.set("topic0", topic0);
    url.searchParams.set("offset", EXPLORER_PAGE_SIZE.toString());

    const response = await fetch(url, {
      cache: "no-store",
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(EXPLORER_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`Explorer log request failed: ${response.status}`);
    }

  const payload = await readLimitedJson<ExplorerLogsResponse>(
    response,
    MAX_EXPLORER_RESPONSE_BYTES,
  );
    if (!Array.isArray(payload.result)) {
      if (payload.message === "No logs found") continue;
      throw new Error(payload.message || "Explorer returned invalid log data");
    }

    if (payload.result.length >= EXPLORER_PAGE_SIZE) {
      if (rangeStart >= rangeEnd) {
        throw new Error("Explorer activity result cap exceeded in one block");
      }
      const midpoint = (rangeStart + rangeEnd) / 2n;
      ranges.push([rangeStart, midpoint], [midpoint + 1n, rangeEnd]);
      continue;
    }
    logs.push(...payload.result);
  }

  return Array.from(
    new Map(logs.map((log) => [`${log.transactionHash}:${log.logIndex}`, log])).values()
  );
}

function parseMintedLog(log: ExplorerLog, collection: `0x${string}` = PIXEL_NFT_CONTRACT_ADDRESS): SubgraphMarketEventDTO | null {
  const creator = addressFromTopic(log.topics[1]);
  const tokenId = uintFromTopic(log.topics[2]);
  if (!creator || tokenId === null) return null;

  let name = `Token #${tokenId.toString()}`;
  try {
    const [decodedName] = decodeAbiParameters([{ type: "string" }], log.data);
    if (decodedName) name = decodedName;
  } catch {
    // The event identity is still usable if a provider returns truncated data.
  }

  const timestamp = parseRpcNumber(log.timeStamp);
  const tokenIdString = tokenId.toString();
  return {
    id: eventId(log),
    listingId: "0",
    tokenId: tokenIdString,
    collection,
    eventType: "MINTED",
    price: null,
    seller: creator,
    buyer: null,
    timestamp,
    blockNumber: parseRpcNumber(log.blockNumber),
    txHash: log.transactionHash.toLowerCase() as `0x${string}`,
    token: {
      tokenId: tokenIdString,
      name,
      imageUrl: "",
      creator,
      mintedAt: timestamp,
    },
  };
}

function parseListedLog(log: ExplorerLog): {
  context: ListingContext;
  event: SubgraphMarketEventDTO;
} | null {
  const listingId = uintFromTopic(log.topics[1]);
  const collection = addressFromTopic(log.topics[2]);
  if (
    listingId === null ||
    !collection ||
    !isPixelCollection(collection)
  ) {
    return null;
  }

  try {
    const [tokenId, seller, price] = decodeAbiParameters(
      [{ type: "uint256" }, { type: "address" }, { type: "uint256" }],
      log.data
    );
    const context: ListingContext = {
      collection,
      listingId: listingId.toString(),
      tokenId: tokenId.toString(),
      price: price.toString(),
      seller: seller.toLowerCase() as `0x${string}`,
    };
    return {
      context,
      event: marketEvent(log, context, "LISTED", context.price, null),
    };
  } catch {
    return null;
  }
}

function parseBoughtLog(
  log: ExplorerLog,
  listings: Map<string, ListingContext>
): SubgraphMarketEventDTO | null {
  const listingId = uintFromTopic(log.topics[1]);
  if (listingId === null) return null;
  const context = listings.get(listingId.toString());
  if (!context) return null;

  try {
    const [buyer, price] = decodeAbiParameters(
      [{ type: "address" }, { type: "uint256" }],
      log.data
    );
    return marketEvent(
      log,
      context,
      "BOUGHT",
      price.toString(),
      buyer.toLowerCase() as `0x${string}`
    );
  } catch {
    return null;
  }
}

function parseCancelledLog(
  log: ExplorerLog,
  listings: Map<string, ListingContext>
): SubgraphMarketEventDTO | null {
  const listingId = uintFromTopic(log.topics[1]);
  if (listingId === null) return null;
  const context = listings.get(listingId.toString());
  return context
    ? marketEvent(log, context, "CANCELLED", context.price, null)
    : null;
}

function marketEvent(
  log: ExplorerLog,
  context: ListingContext,
  eventType: Exclude<SubgraphMarketEventType, "MINTED">,
  price: string | null,
  buyer: `0x${string}` | null
): SubgraphMarketEventDTO {
  return {
    id: eventId(log),
    listingId: context.listingId,
    tokenId: context.tokenId,
    collection: context.collection,
    eventType,
    price,
    seller: context.seller,
    buyer,
    timestamp: parseRpcNumber(log.timeStamp),
    blockNumber: parseRpcNumber(log.blockNumber),
    txHash: log.transactionHash.toLowerCase() as `0x${string}`,
    token: null,
  };
}

async function fetchTokenMetadata(
  tokenIds: string[], collection: `0x${string}`
): Promise<Record<string, SubgraphTokenMetadata | null>> {
  const output: Record<string, SubgraphTokenMetadata | null> = {};
  const missing: string[] = [];

  for (const tokenId of tokenIds) {
    const cached = tokenCache.get(pixelTokenKey(collection, tokenId));
    // A cached null records a token whose on-chain read failed; only `undefined` is a miss.
    if (cached !== undefined) {
      output[tokenId] = cached;
    } else {
      missing.push(tokenId);
    }
  }
  if (missing.length === 0) return output;

  const results = await publicClient.multicall({
    allowFailure: true,
    contracts: missing.map((tokenId) => ({
      address: collection,
      abi: PixelNFTABI,
      functionName: "tokenData" as const,
      args: [BigInt(tokenId)] as const,
    })),
  });

  for (let index = 0; index < missing.length; index += 1) {
    const tokenId = missing[index];
    const result = results[index];
    let metadata: SubgraphTokenMetadata | null = null;
    if (result?.status === "success") {
      const [name, gridSize, pixelData, creator, mintedAt] = result.result as readonly [
        string,
        bigint,
        string,
        `0x${string}`,
        bigint,
        string,
      ];
      metadata = {
        tokenId,
        name: name || `Token #${tokenId}`,
        imageUrl:
          pixelData && gridSize > 0n
            ? getPixelImageUrl(tokenId, collection)
            : "",
        creator: creator.toLowerCase() as `0x${string}`,
        mintedAt: Number(mintedAt),
      };
    }
    tokenCache.set(pixelTokenKey(collection, tokenId), metadata);
    output[tokenId] = metadata;
  }

  return output;
}

function eventTopic(signature: string): Hex {
  return keccak256(toBytes(signature));
}

function eventId(log: ExplorerLog): string {
  return `${log.transactionHash.toLowerCase()}-${parseRpcNumber(log.logIndex)}`;
}

function addressFromTopic(topic: Hex | null | undefined): `0x${string}` | null {
  if (!topic || topic.length < 42) return null;
  return `0x${topic.slice(-40)}`.toLowerCase() as `0x${string}`;
}

function uintFromTopic(topic: Hex | null | undefined): bigint | null {
  if (!topic) return null;
  try {
    return BigInt(topic);
  } catch {
    return null;
  }
}

function parseRpcNumber(value: string): number {
  const parsed = value.startsWith("0x") ? Number(BigInt(value)) : Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function isPresent<T>(value: T | null): value is T {
  return value !== null;
}
