import { getAddress, isAddress, keccak256, parseAbi, parseUnits, toBytes, zeroAddress, type Address, type PublicClient } from "viem";

/** 0.1% of every sale is burned and 0.4% goes to the creator; there is no platform fee. The marker is fixed on chain. */
export const NUSD_MARKET_IMPLEMENTATION = keccak256(toBytes("0xpixel.nusd.marketplace.v2"));
export const NUSD_MARKET_PAGE_SIZE = 24;
export const NUSD_CATALOGUE_LIMIT = 1000;
export const NUSD_MAX_PRICE = (1n << 128n) - 1n;

export const NusdMarketplaceAbi = parseAbi([
  "function IMPLEMENTATION_ID() view returns (bytes32)",
  "function nusd() view returns (address)",
  "function BURN_BPS() view returns (uint16)",
  "function CREATOR_BPS() view returns (uint16)",
  "function paused() view returns (bool)",
  "function activeListingCount() view returns (uint256)",
  "function activeOfferCount() view returns (uint256)",
  "function totalVolumeNusd() view returns (uint256)",
  "function escrowedNusd() view returns (uint256)",
  "function credits(address account) view returns (uint256)",
  "function collectionAllowed(address collection) view returns (bool)",
  "function tokenToListingId(address collection, uint256 tokenId) view returns (uint256)",
  "function getActiveListings(uint256 offset, uint256 limit) view returns (uint256[])",
  "function getActiveOffers(uint256 offset, uint256 limit) view returns (uint256[])",
  "function listings(uint256 id) view returns (address collection, uint256 tokenId, uint256 price, address seller, bool active)",
  "function offers(uint256 id) view returns (address collection, uint256 tokenId, address offerer, uint256 price, uint64 expiresAt, bool active)",
  "function quoteSale(address collection, uint256 tokenId, uint256 price) view returns (uint256 burnAmount, address creator, uint256 creatorFee, uint256 sellerProceeds)",
  "function list(address collection, uint256 tokenId, uint256 price) returns (uint256 listingId)",
  "function updateListingPrice(uint256 listingId, uint256 price)",
  "function buy(uint256 listingId, uint256 expectedPrice, uint256 maxWalletPayment)",
  "function cancelListing(uint256 listingId)",
  "function makeOffer(address collection, uint256 tokenId, uint256 price, uint64 expiresAt, uint256 maxWalletPayment) returns (uint256 offerId)",
  "function acceptOffer(uint256 offerId, uint256 minimumSellerProceeds)",
  "function cancelOffer(uint256 offerId)",
  "function expireOffer(uint256 offerId)",
  "function withdrawNusd(address recipient)",
  "error PriceChanged()",
  "error WalletPaymentExceeded()",
  "error InsufficientProceeds()",
  "error Inactive()",
  "error InvalidExpiry()",
  "error NotPurchasable()",
  "error CollectionNotAllowed()",
]);

const walletTokenAbi = parseAbi(["function balanceOf(address account) view returns (uint256)"]);
const ownerAbi = parseAbi(["function ownerOf(uint256 tokenId) view returns (address)"]);

export function nusdMarketplaceAddress(value: string | undefined): Address | undefined {
  const candidate = value?.trim();
  return candidate && isAddress(candidate) && candidate.toLowerCase() !== zeroAddress ? getAddress(candidate) : undefined;
}

export function nusdNftSelection(collection: unknown, tokenId: unknown): string {
  if (typeof collection !== "string" || typeof tokenId !== "string") return "";
  const address = nusdMarketplaceAddress(collection);
  if (!address || !tokenId || !/^\d{1,78}$/.test(tokenId)) return "";
  const identifier = BigInt(tokenId);
  if (identifier >= (1n << 256n)) return "";
  return `${address.toLowerCase()}:${identifier}`;
}

export function parseNusdPrice(value: string): bigint | undefined {
  const candidate = value.trim();
  if (candidate.length > 78 || !/^\d+(?:\.\d{1,18})?$/.test(candidate)) return undefined;
  const price = parseUnits(candidate, 18);
  return price > 0n && price <= NUSD_MAX_PRICE ? price : undefined;
}

export function nusdFunding(price: bigint, credit: bigint) {
  if (price <= 0n || price > NUSD_MAX_PRICE || credit < 0n) throw new Error("Invalid NUSD funding amount");
  const creditUsed = credit < price ? credit : price;
  return { creditUsed, walletPayment: price - creditUsed };
}

export function offerExpiry(timestamp: bigint, hours: string): bigint {
  if (timestamp < 0n || !/^\d{1,3}$/.test(hours) || Number(hours) < 1 || Number(hours) > 720) throw new Error("Offer duration must be 1–720 hours");
  const expiresAt = timestamp + BigInt(hours) * 3600n;
  if (expiresAt > (1n << 64n) - 1n) throw new Error("Invalid offer clock");
  return expiresAt;
}

// Freshness is measured on the local clock only (read age). Comparing the local
// clock with the block timestamp blocked every wallet whose system clock drifted
// by minutes; a lagging RPC is still caught onchain by expectedPrice,
// maxWalletPayment and minimumSellerProceeds plus pre-signing simulation.
export function requireFreshNusdMarket(state: { readAt: number; timestamp: bigint; paused: boolean }, settlement: boolean, now = Date.now()) {
  if (!Number.isFinite(now) || !Number.isFinite(state.readAt) || state.timestamp < 0n || now < state.readAt || now - state.readAt > 60_000) throw new Error("Marketplace data is stale. Refresh before signing.");
  if (settlement && state.paused) throw new Error("Trading is paused. Cancelling offers and withdrawing credits remain available.");
}

type NusdMarketClient = Pick<PublicClient, "getChainId" | "getBlock" | "readContract">;

export async function readNusdListing(client: Pick<PublicClient, "readContract">, market: Address, id: bigint, blockNumber: bigint) {
  const [collection, tokenId, price, seller, active] = await client.readContract({ address: market, abi: NusdMarketplaceAbi, functionName: "listings", args: [id], blockNumber });
  return { id, collection, tokenId, price, seller, active };
}

export async function readNusdOffer(client: Pick<PublicClient, "readContract">, market: Address, id: bigint, blockNumber: bigint) {
  const [collection, tokenId, offerer, price, expiresAt, active] = await client.readContract({ address: market, abi: NusdMarketplaceAbi, functionName: "offers", args: [id], blockNumber });
  const owner = await client.readContract({ address: collection, abi: ownerAbi, functionName: "ownerOf", args: [tokenId], blockNumber }).catch(() => undefined);
  return { id, collection, tokenId, offerer, price, expiresAt, active, owner };
}

/**
 * Reads the verified market state pinned to one mined block. `include` lets a
 * caller skip the listing catalogue or the offer page: the dashboard loads them
 * as separate queries and pre-signing checks need only the header plus the one
 * listing or offer being settled.
 */
export async function readNusdMarket(
  client: NusdMarketClient,
  market: Address,
  expectedNusd: Address,
  account: Address | undefined,
  page = 0,
  catalogue = false,
  include: { listings?: boolean; offers?: boolean } = {},
) {
  if (!Number.isSafeInteger(page) || page < 0) throw new Error("Invalid marketplace page");
  const withListings = include.listings ?? true;
  const withOffers = include.offers ?? true;
  const [chainId, block] = await Promise.all([client.getChainId(), client.getBlock({ blockTag: "latest" })]);
  if (chainId !== 4441) throw new Error("Marketplace RPC is not LiteForge 4441");
  if (block.number === null) throw new Error("Marketplace RPC did not return a mined block");
  const blockNumber = block.number;
  const contract = { address: market, abi: NusdMarketplaceAbi, blockNumber };
  const [token, implementation] = await Promise.all([
    client.readContract({ ...contract, functionName: "nusd" }),
    client.readContract({ ...contract, functionName: "IMPLEMENTATION_ID" }),
  ]);
  if (token.toLowerCase() !== expectedNusd.toLowerCase() || implementation.toLowerCase() !== NUSD_MARKET_IMPLEMENTATION.toLowerCase()) throw new Error("NUSD marketplace token or implementation does not match configuration");
  const offset = BigInt(page) * BigInt(NUSD_MARKET_PAGE_SIZE);
  const none = Promise.resolve([] as readonly bigint[]);
  const [paused, [burnBps, creatorBps], listingCount, offerCount, volume, escrow, credit, balance, listingIds, offerIds] = await Promise.all([
    client.readContract({ ...contract, functionName: "paused" }),
    Promise.all([
      client.readContract({ ...contract, functionName: "BURN_BPS" }),
      client.readContract({ ...contract, functionName: "CREATOR_BPS" }),
    ]),
    client.readContract({ ...contract, functionName: "activeListingCount" }),
    client.readContract({ ...contract, functionName: "activeOfferCount" }),
    client.readContract({ ...contract, functionName: "totalVolumeNusd" }),
    client.readContract({ ...contract, functionName: "escrowedNusd" }),
    account ? client.readContract({ ...contract, functionName: "credits", args: [account] }) : Promise.resolve(0n),
    account ? client.readContract({ address: expectedNusd, abi: walletTokenAbi, functionName: "balanceOf", args: [account], blockNumber }) : Promise.resolve(0n),
    withListings ? client.readContract({ ...contract, functionName: "getActiveListings", args: [catalogue ? 0n : offset, BigInt(NUSD_MARKET_PAGE_SIZE)] }) : none,
    withOffers ? client.readContract({ ...contract, functionName: "getActiveOffers", args: [offset, BigInt(NUSD_MARKET_PAGE_SIZE)] }) : none,
  ]);
  const feeBps = burnBps + creatorBps;
  if (feeBps > 500 || listingIds.length > NUSD_MARKET_PAGE_SIZE || offerIds.length > NUSD_MARKET_PAGE_SIZE) throw new Error("Invalid marketplace fee or page size");
  const catalogueComplete = withListings && catalogue && listingCount <= BigInt(NUSD_CATALOGUE_LIMIT);
  let ids = listingIds;
  if (catalogueComplete) {
    const offsets = Array.from({ length: Math.max(0, Math.ceil(Number(listingCount) / NUSD_MARKET_PAGE_SIZE) - 1) }, (_, index) => BigInt((index + 1) * NUSD_MARKET_PAGE_SIZE));
    const pages = await mapNusdReads(offsets, (start) => client.readContract({ ...contract, functionName: "getActiveListings", args: [start, BigInt(NUSD_MARKET_PAGE_SIZE)] }));
    if (pages.some((items) => items.length > NUSD_MARKET_PAGE_SIZE)) throw new Error("Invalid marketplace catalogue page size");
    ids = [...listingIds, ...pages.flat()];
    if (BigInt(ids.length) !== listingCount || new Set(ids.map(String)).size !== ids.length) throw new Error("Incomplete marketplace catalogue");
  } else if (withListings && catalogue && page > 0) {
    ids = await client.readContract({ ...contract, functionName: "getActiveListings", args: [offset, BigInt(NUSD_MARKET_PAGE_SIZE)] });
    if (ids.length > NUSD_MARKET_PAGE_SIZE) throw new Error("Invalid marketplace page size");
  }
  const [listings, offers] = await Promise.all([
    mapNusdReads(ids, (id) => readNusdListing(client, market, id, blockNumber)),
    mapNusdReads(offerIds, (id) => readNusdOffer(client, market, id, blockNumber)),
  ]);
  return { blockNumber, timestamp: block.timestamp, readAt: Date.now(), paused, feeBps, burnBps, creatorBps, listingCount, offerCount, volume, escrow, credit, balance, listings, offers, catalogueComplete };
}

// Reads issued in the same tick are folded into one multicall by the batching
// client, so this bound sets calls per round-trip, not concurrent HTTP requests.
const NUSD_READ_CONCURRENCY = 64;

async function mapNusdReads<Item, Result>(items: readonly Item[], read: (item: Item) => Promise<Result>): Promise<Result[]> {
  const values: Result[] = new Array(items.length);
  let nextIndex = 0;
  await Promise.all(Array.from({ length: Math.min(NUSD_READ_CONCURRENCY, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      values[index] = await read(items[index]);
    }
  }));
  return values;
}
