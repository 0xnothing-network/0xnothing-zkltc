import { getAddress, isAddress, keccak256, parseAbi, parseUnits, toBytes, zeroAddress, type Address, type PublicClient } from "viem";

export const NUSD_MARKET_IMPLEMENTATION = keccak256(toBytes("0xpixel.nusd.marketplace.v2"));
export const NUSD_MARKET_PAGE_SIZE = 24;
export const NUSD_CATALOGUE_LIMIT = 1000;
export const NUSD_MAX_PRICE = (1n << 128n) - 1n;

export const NusdMarketplaceAbi = parseAbi([
  "function IMPLEMENTATION_ID() view returns (bytes32)",
  "function nusd() view returns (address)",
  "function platformFeeBps() view returns (uint16)",
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
  "function quoteSale(address collection, uint256 tokenId, uint256 price) view returns (uint256 fee, address royaltyReceiver, uint256 royalty, uint256 sellerProceeds)",
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
  "error InvalidRoyalty()",
  "error InsufficientProceeds()",
  "error Inactive()",
  "error InvalidExpiry()",
  "error NotPurchasable()",
  "error CollectionNotAllowed()",
]);

const walletTokenAbi = parseAbi(["function balanceOf(address account) view returns (uint256)"]);
const ownerAbi = parseAbi(["function ownerOf(uint256 tokenId) view returns (address)"]);

export function nusdMarketplaceAddress(value: string | null | undefined): Address | undefined {
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

export function requireFreshNusdMarket(state: { readAt: number; timestamp: bigint; paused: boolean }, settlement: boolean, now = Date.now()) {
  if (!Number.isFinite(now) || !Number.isFinite(state.readAt) || state.timestamp < 0n || now < state.readAt || now - state.readAt > 60_000 || Math.abs(now / 1000 - Number(state.timestamp)) > 120) throw new Error("Marketplace data is stale. Refresh before signing.");
  if (settlement && state.paused) throw new Error("Trading is paused. Cancelling offers and withdrawing credits remain available.");
}

export async function readNusdMarket(
  client: Pick<PublicClient, "getChainId" | "getBlock" | "readContract">,
  market: Address,
  expectedNusd: Address,
  account: Address | undefined,
  page = 0,
  catalogue = false,
) {
  if (!Number.isSafeInteger(page) || page < 0) throw new Error("Invalid marketplace page");
  const [chainId, block] = await Promise.all([client.getChainId(), client.getBlock({ blockTag: "latest" })]);
  if (chainId !== 4441) throw new Error("Marketplace RPC is not LiteForge 4441");
  if (block.number === null) throw new Error("Marketplace RPC did not return a mined block");
  const contract = { address: market, abi: NusdMarketplaceAbi, blockNumber: block.number };
  const [token, implementation] = await Promise.all([
    client.readContract({ ...contract, functionName: "nusd" }),
    client.readContract({ ...contract, functionName: "IMPLEMENTATION_ID" }),
  ]);
  if (token.toLowerCase() !== expectedNusd.toLowerCase() || implementation.toLowerCase() !== NUSD_MARKET_IMPLEMENTATION.toLowerCase()) throw new Error("NUSD marketplace token or implementation does not match configuration");
  const offset = BigInt(page) * BigInt(NUSD_MARKET_PAGE_SIZE);
  const [paused, feeBps, listingCount, offerCount, volume, escrow, credit, balance, listingIds, offerIds] = await Promise.all([
    client.readContract({ ...contract, functionName: "paused" }),
    client.readContract({ ...contract, functionName: "platformFeeBps" }),
    client.readContract({ ...contract, functionName: "activeListingCount" }),
    client.readContract({ ...contract, functionName: "activeOfferCount" }),
    client.readContract({ ...contract, functionName: "totalVolumeNusd" }),
    client.readContract({ ...contract, functionName: "escrowedNusd" }),
    account ? client.readContract({ ...contract, functionName: "credits", args: [account] }) : Promise.resolve(0n),
    account ? client.readContract({ address: expectedNusd, abi: walletTokenAbi, functionName: "balanceOf", args: [account], blockNumber: block.number }) : Promise.resolve(0n),
    client.readContract({ ...contract, functionName: "getActiveListings", args: [catalogue ? 0n : offset, BigInt(NUSD_MARKET_PAGE_SIZE)] }),
    client.readContract({ ...contract, functionName: "getActiveOffers", args: [offset, BigInt(NUSD_MARKET_PAGE_SIZE)] }),
  ]);
  if (feeBps > 500 || listingIds.length > NUSD_MARKET_PAGE_SIZE || offerIds.length > NUSD_MARKET_PAGE_SIZE) throw new Error("Invalid marketplace fee or page size");
  const catalogueComplete = catalogue && listingCount <= BigInt(NUSD_CATALOGUE_LIMIT);
  let ids = listingIds;
  if (catalogueComplete) {
    const offsets = Array.from({ length: Math.max(0, Math.ceil(Number(listingCount) / NUSD_MARKET_PAGE_SIZE) - 1) }, (_, index) => BigInt((index + 1) * NUSD_MARKET_PAGE_SIZE));
    const pages = await mapNusdReads(offsets, (start) => client.readContract({ ...contract, functionName: "getActiveListings", args: [start, BigInt(NUSD_MARKET_PAGE_SIZE)] }));
    if (pages.some((items) => items.length > NUSD_MARKET_PAGE_SIZE)) throw new Error("Invalid marketplace catalogue page size");
    ids = [...listingIds, ...pages.flat()];
    if (BigInt(ids.length) !== listingCount || new Set(ids.map(String)).size !== ids.length) throw new Error("Incomplete marketplace catalogue");
  } else if (catalogue && page > 0) {
    ids = await client.readContract({ ...contract, functionName: "getActiveListings", args: [offset, BigInt(NUSD_MARKET_PAGE_SIZE)] });
    if (ids.length > NUSD_MARKET_PAGE_SIZE) throw new Error("Invalid marketplace page size");
  }
  const listings = await mapNusdReads(ids, async (id) => {
    const [collection, tokenId, price, seller, active] = await client.readContract({ ...contract, functionName: "listings", args: [id] });
    return { id, collection, tokenId, price, seller, active };
  });
  const offers = await Promise.all(offerIds.map(async (id) => {
    const [collection, tokenId, offerer, price, expiresAt, active] = await client.readContract({ ...contract, functionName: "offers", args: [id] });
    const owner = await client.readContract({ address: collection, abi: ownerAbi, functionName: "ownerOf", args: [tokenId], blockNumber: block.number }).catch(() => undefined);
    return { id, collection, tokenId, offerer, price, expiresAt, active, owner };
  }));
  return { blockNumber: block.number, timestamp: block.timestamp, readAt: Date.now(), paused, feeBps, listingCount, offerCount, volume, escrow, credit, balance, listings, offers, catalogueComplete };
}

async function mapNusdReads<Item, Result>(items: readonly Item[], read: (item: Item) => Promise<Result>): Promise<Result[]> {
  const values: Result[] = new Array(items.length);
  let nextIndex = 0;
  await Promise.all(Array.from({ length: Math.min(12, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      values[index] = await read(items[index]);
    }
  }));
  return values;
}
