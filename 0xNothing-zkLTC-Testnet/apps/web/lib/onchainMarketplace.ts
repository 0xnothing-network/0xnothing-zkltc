import {
  decodeAbiParameters,
  keccak256,
  toBytes,
  type Hex,
} from "viem";
import { PixelNFTABI } from "@/lib/abi";
import {
  LITVM_EXPLORER_URL,
  PIXEL_MARKETPLACE_ADDRESS,
  PIXEL_NFT_CONTRACT_ADDRESS,
  publicClient,
} from "@/lib/contract";
import { getPixelImageUrl } from "@/lib/pixelImage";
import {
  MARKETPLACE_START_BLOCK as PUBLIC_MARKETPLACE_START_BLOCK,
  PIXEL_START_BLOCK as PUBLIC_PIXEL_START_BLOCK,
} from "@/lib/publicConfig";
import type {
  SubgraphMarketEventDTO,
  SubgraphMarketEventType,
  SubgraphTokenMetadata,
} from "@/lib/marketplaceSubgraph";

const PIXEL_START_BLOCK = PUBLIC_PIXEL_START_BLOCK;
const MARKETPLACE_START_BLOCK = PUBLIC_MARKETPLACE_START_BLOCK;
const EXPLORER_PAGE_SIZE = 1_000;
const EXPLORER_MAX_RANGES = 64;
const EXPLORER_TIMEOUT_MS = 8_000;
const RAW_CACHE_TTL_MS = 15_000;
const TOKEN_CACHE_TTL_MS = 60_000;

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

interface ListingContext {
  listingId: string;
  tokenId: string;
  price: string;
  seller: `0x${string}`;
}

interface CacheEntry<T> {
  value: T;
  timestamp: number;
}

let rawEventsCache: CacheEntry<SubgraphMarketEventDTO[]> | null = null;
let rawEventsInFlight: Promise<SubgraphMarketEventDTO[]> | null = null;
const tokenCache = new Map<string, CacheEntry<SubgraphTokenMetadata | null>>();

export async function fetchMarketplaceActivityFromOnchain({
  limit = 30,
  skip = 0,
  eventTypes,
}: {
  limit?: number;
  skip?: number;
  eventTypes?: SubgraphMarketEventType[];
} = {}): Promise<{ events: SubgraphMarketEventDTO[] }> {
  const safeLimit = Math.min(Math.max(1, Math.floor(limit)), 100);
  const safeSkip = Math.max(0, Math.floor(skip));
  const allowedTypes = eventTypes?.length ? new Set(eventTypes) : null;
  const rawEvents = await loadRawEvents();
  const page = rawEvents
    .filter((event) => !allowedTypes || allowedTypes.has(event.eventType))
    .slice(safeSkip, safeSkip + safeLimit);

  const metadata = await fetchTokenMetadata(
    Array.from(new Set(page.map((event) => event.tokenId).filter((id) => id !== "0")))
  );

  return {
    events: page.map((event) => ({
      ...event,
      token: metadata[event.tokenId] ?? event.token,
    })),
  };
}

async function loadRawEvents(): Promise<SubgraphMarketEventDTO[]> {
  if (
    rawEventsCache &&
    Date.now() - rawEventsCache.timestamp < RAW_CACHE_TTL_MS
  ) {
    return rawEventsCache.value;
  }
  if (rawEventsInFlight) return rawEventsInFlight;

  rawEventsInFlight = loadRawEventsUncached();
  try {
    const value = await rawEventsInFlight;
    rawEventsCache = { value, timestamp: Date.now() };
    return value;
  } finally {
    rawEventsInFlight = null;
  }
}

async function loadRawEventsUncached(): Promise<SubgraphMarketEventDTO[]> {
  const latestBlock = await publicClient.getBlockNumber();
  const [mintedLogs, listedLogs, boughtLogs, cancelledLogs, invalidatedLogs] =
    await Promise.all([
      fetchExplorerLogs(
        PIXEL_NFT_CONTRACT_ADDRESS,
        PIXEL_START_BLOCK,
        latestBlock,
        EVENT_TOPICS.minted
      ),
      fetchExplorerLogs(
        PIXEL_MARKETPLACE_ADDRESS,
        MARKETPLACE_START_BLOCK,
        latestBlock,
        EVENT_TOPICS.listed
      ),
      fetchExplorerLogs(
        PIXEL_MARKETPLACE_ADDRESS,
        MARKETPLACE_START_BLOCK,
        latestBlock,
        EVENT_TOPICS.bought
      ),
      fetchExplorerLogs(
        PIXEL_MARKETPLACE_ADDRESS,
        MARKETPLACE_START_BLOCK,
        latestBlock,
        EVENT_TOPICS.cancelled
      ),
      fetchExplorerLogs(
        PIXEL_MARKETPLACE_ADDRESS,
        MARKETPLACE_START_BLOCK,
        latestBlock,
        EVENT_TOPICS.invalidated
      ),
    ]);

  const mintedEvents = mintedLogs.map(parseMintedLog).filter(isPresent);
  const mintedByToken = new Map(
    mintedEvents.map((event) => [event.tokenId, event.token] as const)
  );
  const listings = new Map<string, ListingContext>();
  const marketEvents: SubgraphMarketEventDTO[] = [];

  for (const log of listedLogs) {
    const parsed = parseListedLog(log);
    if (!parsed) continue;
    listings.set(parsed.context.listingId, parsed.context);
    marketEvents.push({
      ...parsed.event,
      token: mintedByToken.get(parsed.event.tokenId) ?? null,
    });
  }

  for (const log of boughtLogs) {
    const parsed = parseBoughtLog(log, listings);
    if (!parsed) continue;
    marketEvents.push({
      ...parsed,
      token: mintedByToken.get(parsed.tokenId) ?? null,
    });
  }

  for (const log of [...cancelledLogs, ...invalidatedLogs]) {
    const parsed = parseCancelledLog(log, listings);
    if (!parsed) continue;
    marketEvents.push({
      ...parsed,
      token: mintedByToken.get(parsed.tokenId) ?? null,
    });
  }

  return [...marketEvents, ...mintedEvents].sort(
    (a, b) =>
      b.timestamp - a.timestamp ||
      b.blockNumber - a.blockNumber ||
      b.id.localeCompare(a.id)
  );
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

    const payload = (await response.json()) as ExplorerLogsResponse;
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

function parseMintedLog(log: ExplorerLog): SubgraphMarketEventDTO | null {
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
    collection.toLowerCase() !== PIXEL_NFT_CONTRACT_ADDRESS.toLowerCase()
  ) {
    return null;
  }

  try {
    const [tokenId, seller, price] = decodeAbiParameters(
      [{ type: "uint256" }, { type: "address" }, { type: "uint256" }],
      log.data
    );
    const context: ListingContext = {
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
  tokenIds: string[]
): Promise<Record<string, SubgraphTokenMetadata | null>> {
  const output: Record<string, SubgraphTokenMetadata | null> = {};
  const missing: string[] = [];

  for (const tokenId of tokenIds) {
    const cached = tokenCache.get(tokenId);
    if (cached && Date.now() - cached.timestamp < TOKEN_CACHE_TTL_MS) {
      output[tokenId] = cached.value;
    } else {
      missing.push(tokenId);
    }
  }
  if (missing.length === 0) return output;

  const results = await publicClient.multicall({
    allowFailure: true,
    contracts: missing.map((tokenId) => ({
      address: PIXEL_NFT_CONTRACT_ADDRESS,
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
            ? getPixelImageUrl(tokenId)
            : "",
        creator: creator.toLowerCase() as `0x${string}`,
        mintedAt: Number(mintedAt),
      };
    }
    tokenCache.set(tokenId, { value: metadata, timestamp: Date.now() });
    output[tokenId] = metadata;
  }

  if (tokenCache.size > 4_096) {
    const now = Date.now();
    for (const [key, entry] of tokenCache) {
      if (now - entry.timestamp >= TOKEN_CACHE_TTL_MS) tokenCache.delete(key);
    }
    while (tokenCache.size > 4_096) {
      const oldestKey = tokenCache.keys().next().value;
      if (oldestKey === undefined) break;
      tokenCache.delete(oldestKey);
    }
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
