import { isAddress, parseAbi, zeroAddress, type Address, type Hex, type PublicClient } from "viem";
import { NUSD_MARKET_IMPLEMENTATION, NusdMarketplaceAbi } from "./nusdMarketplace";

export type NusdActivityFilter = "ALL" | "BOUGHT" | "MINTED" | "LISTED" | "CANCELLED" | "OFFERS";
export type NusdActivityEvent = {
  id: string;
  type: "MINTED" | "LISTED" | "UPDATED" | "BOUGHT" | "CANCELLED" | "OFFER_CREATED" | "OFFER_REFUNDED";
  collection: Address;
  tokenId: string;
  actor: Address;
  other?: Address;
  price: string | null;
  blockNumber: string;
  logIndex: number;
  timestamp: string;
  transactionHash: Hex;
};
export type NusdActivityPage = { events: NusdActivityEvent[]; nextCursor: string | null; fromBlock: string; throughBlock: string };
type ActivityLog = { address: Address; eventName?: string; args: Record<string, unknown>; blockNumber: bigint | null; logIndex: number | null; transactionHash: Hex | null; removed?: boolean };
type ActivityClient = Pick<PublicClient, "getChainId" | "getBlock" | "getLogs" | "readContract">;
const activityEvents = parseAbi([
  "event Listed(uint256 indexed listingId, address indexed collection, uint256 indexed tokenId, address seller, uint256 price)",
  "event ListingCancelled(uint256 indexed listingId)",
  "event ListingInvalidated(uint256 indexed listingId)",
  "event ListingPriceUpdated(uint256 indexed listingId, uint256 price)",
  "event SaleSettled(address indexed seller, address indexed buyer, address indexed collection, uint256 tokenId, uint256 price, uint256 fee, address royaltyReceiver, uint256 royalty)",
  "event OfferCreated(uint256 indexed offerId, address indexed collection, uint256 indexed tokenId, address offerer, uint256 price, uint64 expiresAt)",
  "event OfferCancelled(uint256 indexed offerId, address indexed offerer, uint256 refund)",
]);
const mintEvent = parseAbi(["event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)"])[0];
const ACTIVITY_SLICE_BLOCKS = 500n;
const ACTIVITY_LOG_CONCURRENCY = 8;

async function mapActivityReads<Item, Result>(items: readonly Item[], read: (item: Item) => Promise<Result>): Promise<Result[]> {
  const values: Result[] = new Array(items.length);
  let nextIndex = 0;
  await Promise.all(Array.from({ length: Math.min(ACTIVITY_LOG_CONCURRENCY, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      values[index] = await read(items[index]);
    }
  }));
  return values;
}

export function parseNusdActivityCursor(value: string | null): { block: bigint; index: number } | undefined {
  if (value === null || value === "") return undefined;
  if (!/^\d{1,78}:\d{1,10}$/.test(value)) throw new Error("Invalid activity cursor");
  const [block, index] = value.split(":");
  const result = { block: BigInt(block), index: Number(index) };
  if (result.block >= (1n << 256n) || result.index > 2_147_483_647) throw new Error("Invalid activity cursor");
  return result;
}

function uint(value: unknown): bigint {
  if (typeof value !== "bigint" || value < 0n || value >= (1n << 256n)) throw new Error("Invalid activity integer");
  return value;
}

function address(value: unknown): Address {
  if (typeof value !== "string" || !isAddress(value)) throw new Error("Invalid activity address");
  return value;
}

// Classifies a log without RPC so filtered-out events never cost a contract read.
function activityType(market: Address, collections: readonly Address[], log: ActivityLog): NusdActivityEvent["type"] | undefined {
  if (log.removed || log.blockNumber === null || log.logIndex === null || !Number.isSafeInteger(log.logIndex) || log.logIndex < 0 || log.logIndex > 2_147_483_647 || !log.transactionHash || !/^0x[0-9a-fA-F]{64}$/.test(log.transactionHash)) return undefined;
  if (log.address.toLowerCase() !== market.toLowerCase()) {
    return collections.some((collection) => collection.toLowerCase() === log.address.toLowerCase()) && log.eventName === "Transfer" && log.args.from === zeroAddress ? "MINTED" : undefined;
  }
  switch (log.eventName) {
    case "Listed": return "LISTED";
    case "OfferCreated": return "OFFER_CREATED";
    case "SaleSettled": return "BOUGHT";
    case "OfferCancelled": return "OFFER_REFUNDED";
    case "ListingPriceUpdated": return "UPDATED";
    case "ListingCancelled": case "ListingInvalidated": return "CANCELLED";
    default: return undefined;
  }
}

async function activityFromLog(client: ActivityClient, market: Address, block: bigint, log: ActivityLog & { blockNumber: bigint; logIndex: number; transactionHash: Hex }): Promise<Omit<NusdActivityEvent, "timestamp"> | undefined> {
  const common = { id: `${log.transactionHash}:${log.logIndex}`, transactionHash: log.transactionHash, blockNumber: log.blockNumber.toString(), logIndex: log.logIndex };
  const args = log.args;
  if (log.address.toLowerCase() !== market.toLowerCase()) {
    return { ...common, type: "MINTED", collection: log.address, tokenId: uint(args.tokenId).toString(), actor: address(args.to), price: null };
  }
  if (log.eventName === "Listed" || log.eventName === "OfferCreated" || log.eventName === "SaleSettled") {
    return {
      ...common,
      type: log.eventName === "Listed" ? "LISTED" : log.eventName === "OfferCreated" ? "OFFER_CREATED" : "BOUGHT",
      collection: address(args.collection), tokenId: uint(args.tokenId).toString(),
      actor: address(log.eventName === "OfferCreated" ? args.offerer : args.seller),
      other: log.eventName === "SaleSettled" ? address(args.buyer) : undefined,
      price: uint(args.price).toString(),
    };
  }
  if (log.eventName === "OfferCancelled") {
    const [collection, tokenId] = await client.readContract({ address: market, abi: NusdMarketplaceAbi, functionName: "offers", args: [uint(args.offerId)], blockNumber: block });
    return { ...common, type: "OFFER_REFUNDED", collection, tokenId: tokenId.toString(), actor: address(args.offerer), price: uint(args.refund).toString() };
  }
  if (log.eventName === "ListingCancelled" || log.eventName === "ListingInvalidated" || log.eventName === "ListingPriceUpdated") {
    const [collection, tokenId, price, seller] = await client.readContract({ address: market, abi: NusdMarketplaceAbi, functionName: "listings", args: [uint(args.listingId)], blockNumber: block });
    return { ...common, type: log.eventName === "ListingPriceUpdated" ? "UPDATED" : "CANCELLED", collection, tokenId: tokenId.toString(), actor: seller, price: (log.eventName === "ListingPriceUpdated" ? uint(args.price) : price).toString() };
  }
  return undefined;
}

function matchesActivity(type: NusdActivityEvent["type"], filter: NusdActivityFilter): boolean {
  return filter === "ALL" || type === filter || (filter === "LISTED" && type === "UPDATED") || (filter === "OFFERS" && (type === "OFFER_CREATED" || type === "OFFER_REFUNDED"));
}

export async function readNusdMarketActivity(
  client: ActivityClient,
  options: { market: Address; nusd: Address; collections: readonly Address[]; deploymentBlock: bigint; cursor?: string | null; filter: NusdActivityFilter; limit: number },
): Promise<NusdActivityPage> {
  if (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > 100 || options.deploymentBlock < 0n) throw new Error("Invalid activity request");
  const cursor = parseNusdActivityCursor(options.cursor ?? null);
  const [chainId, latest] = await Promise.all([client.getChainId(), client.getBlock({ blockTag: "latest" })]);
  if (chainId !== 4441 || latest.number === null || latest.timestamp < 0n || latest.timestamp > 8_640_000_000_000n || (cursor && cursor.block > latest.number)) throw new Error("Invalid activity chain or block");
  const identity = { address: options.market, abi: NusdMarketplaceAbi, blockNumber: latest.number };
  const [token, implementation] = await Promise.all([
    client.readContract({ ...identity, functionName: "nusd" }),
    client.readContract({ ...identity, functionName: "IMPLEMENTATION_ID" }),
  ]);
  if (token.toLowerCase() !== options.nusd.toLowerCase() || implementation.toLowerCase() !== NUSD_MARKET_IMPLEMENTATION.toLowerCase()) throw new Error("Invalid NUSD marketplace identity");
  // Up to four 2,000-block windows, newest first. LiteForge getLogs latency grows
  // with block span (~0.26s blocks), so every window is split into 500-block
  // slices and all slices are fetched up front with bounded concurrency: in a
  // sparse market nearly every request needs all four windows anyway. The
  // client must not JSON-RPC-batch getLogs, or the node serialises them.
  const windows: { from: bigint; through: bigint }[] = [];
  for (let top = cursor?.block ?? latest.number; windows.length < 4 && top >= options.deploymentBlock;) {
    const bottom = top > options.deploymentBlock + 1999n ? top - 1999n : options.deploymentBlock;
    windows.push({ from: bottom, through: top });
    if (bottom === options.deploymentBlock) break;
    top = bottom - 1n;
  }
  const slices = windows.flatMap((window, index) => {
    const parts: { window: number; fromBlock: bigint; toBlock: bigint }[] = [];
    for (let top = window.through; top >= window.from; top -= ACTIVITY_SLICE_BLOCKS) {
      parts.push({ window: index, fromBlock: top - ACTIVITY_SLICE_BLOCKS + 1n > window.from ? top - ACTIVITY_SLICE_BLOCKS + 1n : window.from, toBlock: top });
      if (top - ACTIVITY_SLICE_BLOCKS < window.from) break;
    }
    return parts;
  });
  const sliceLogs = await mapActivityReads(slices, ({ fromBlock, toBlock }) => Promise.all([
    client.getLogs({ address: options.market, events: activityEvents, fromBlock, toBlock, strict: true }),
    options.collections.length ? client.getLogs({ address: [...options.collections], event: mintEvent, args: { from: zeroAddress }, fromBlock, toBlock, strict: true }) : Promise.resolve([]),
  ]));
  let through = cursor?.block ?? latest.number;
  let from = through;
  let nextCursor: string | null = null;
  const found: Omit<NusdActivityEvent, "timestamp">[] = [];
  const seen = new Set<string>();
  for (let window = 0; window < windows.length; window++) {
    ({ from, through } = windows[window]);
    const logs = slices.flatMap((slice, index) => slice.window === window ? sliceLogs[index].flat() : []) as unknown as ActivityLog[];
    if (logs.length > 4000) throw new Error("Activity window exceeds the safe log limit");
    logs.sort((first, second) => first.blockNumber === second.blockNumber ? (second.logIndex ?? 0) - (first.logIndex ?? 0) : (first.blockNumber ?? 0n) > (second.blockNumber ?? 0n) ? -1 : 1);
    const selected: Parameters<typeof activityFromLog>[3][] = [];
    for (const log of logs) {
      if (log.blockNumber === null || log.blockNumber < from || log.blockNumber > through || (cursor && log.blockNumber === cursor.block && (log.logIndex ?? 0) >= cursor.index)) continue;
      const type = activityType(options.market, options.collections, log);
      const id = `${log.transactionHash}:${log.logIndex}`;
      if (!type || !matchesActivity(type, options.filter) || seen.has(id)) continue;
      seen.add(id);
      selected.push(log as Parameters<typeof activityFromLog>[3]);
      if (found.length + selected.length === options.limit) break;
    }
    // Identity reads for one window are independent; issuing them together lets
    // the server client's multicall batching collapse them into one round-trip.
    const events = await Promise.all(selected.map((log) => activityFromLog(client, options.market, latest.number, log)));
    for (const event of events) if (event) found.push(event);
    if (found.length === options.limit) {
      const last = found[found.length - 1];
      nextCursor = `${last.blockNumber}:${last.logIndex}`;
      break;
    }
    if (from === options.deploymentBlock) break;
    nextCursor = `${from - 1n}:2147483647`;
  }
  if (found.length < options.limit && from === options.deploymentBlock) nextCursor = null;
  const timestamps = new Map<string, string>([[latest.number.toString(), latest.timestamp.toString()]]);
  const missingBlocks = Array.from(new Set(found.map((event) => event.blockNumber))).filter((blockNumber) => !timestamps.has(blockNumber));
  const blocks = await Promise.all(missingBlocks.map((blockNumber) => client.getBlock({ blockNumber: BigInt(blockNumber) })));
  blocks.forEach((block, index) => {
    const blockNumber = missingBlocks[index];
    if (block.number !== BigInt(blockNumber) || block.timestamp < 0n || block.timestamp > 8_640_000_000_000n) throw new Error("Activity block was not found");
    timestamps.set(blockNumber, block.timestamp.toString());
  });
  return { events: found.map((event) => ({ ...event, timestamp: timestamps.get(event.blockNumber)! })), nextCursor, fromBlock: from.toString(), throughBlock: (cursor?.block ?? latest.number).toString() };
}
