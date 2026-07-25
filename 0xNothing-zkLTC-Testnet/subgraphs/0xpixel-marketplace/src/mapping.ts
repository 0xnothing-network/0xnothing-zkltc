import { BigInt, Bytes, Address } from '@graphprotocol/graph-ts';
import {
  Account,
  Listing,
  MarketEvent,
  MarketplaceStats,
  Token,
  TransferEvent,
} from '../generated/schema';
import {
  Minted,
  Transfer,
  PixelNFT,
} from '../generated/PixelNFT/PixelNFT';
import {
  Listed,
  Bought,
  ListingCancelled,
} from '../generated/Marketplace/Marketplace';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const PIXEL_COLLECTION = Address.fromString('0x33A32b9b2BEe864f9e42BFa39cA7BDC72f655988');
const STATS_ID = 'global';
const ZERO_BI = BigInt.fromI32(0);
const ONE_BI = BigInt.fromI32(1);

function eventId(txHash: Bytes, logIndex: BigInt): string {
  return txHash.toHexString() + '-' + logIndex.toString();
}

function tokenEntityId(collection: Bytes, tokenId: BigInt): string {
  return collection.toHexString() + '-' + tokenId.toString();
}

function accountId(address: Bytes): string {
  return address.toHexString();
}

function isZeroAddress(address: Bytes): boolean {
  return address.toHexString() == ZERO_ADDRESS;
}

function getStats(timestamp: BigInt): MarketplaceStats {
  let stats = MarketplaceStats.load(STATS_ID);
  if (stats === null) {
    stats = new MarketplaceStats(STATS_ID);
    stats.totalTokens = ZERO_BI;
    stats.totalListings = ZERO_BI;
    stats.activeListings = ZERO_BI;
    stats.totalSales = ZERO_BI;
    stats.totalVolume = ZERO_BI;
    stats.updatedAt = timestamp;
  }
  return stats;
}

function getAccount(address: Bytes, timestamp: BigInt): Account {
  const id = accountId(address);
  let account = Account.load(id);
  if (account === null) {
    account = new Account(id);
    account.tokenCount = ZERO_BI;
    account.listingCount = ZERO_BI;
    account.activeListingCount = ZERO_BI;
    account.createdAt = timestamp;
    account.updatedAt = timestamp;
  }
  return account;
}

function incrementAccountTokens(address: Bytes, timestamp: BigInt): void {
  if (isZeroAddress(address)) return;
  const account = getAccount(address, timestamp);
  account.tokenCount = account.tokenCount.plus(ONE_BI);
  account.updatedAt = timestamp;
  account.save();
}

function decrementAccountTokens(address: Bytes, timestamp: BigInt): void {
  if (isZeroAddress(address)) return;
  const account = getAccount(address, timestamp);
  account.tokenCount = account.tokenCount.gt(ZERO_BI)
    ? account.tokenCount.minus(ONE_BI)
    : ZERO_BI;
  account.updatedAt = timestamp;
  account.save();
}

function incrementAccountActiveListings(address: Bytes, timestamp: BigInt): void {
  if (isZeroAddress(address)) return;
  const account = getAccount(address, timestamp);
  account.activeListingCount = account.activeListingCount.plus(ONE_BI);
  account.updatedAt = timestamp;
  account.save();
}

function decrementAccountActiveListings(address: Bytes, timestamp: BigInt): void {
  if (isZeroAddress(address)) return;
  const account = getAccount(address, timestamp);
  account.activeListingCount = account.activeListingCount.gt(ZERO_BI)
    ? account.activeListingCount.minus(ONE_BI)
    : ZERO_BI;
  account.updatedAt = timestamp;
  account.save();
}

function getOrCreateToken(
  collection: Bytes,
  tokenId: BigInt,
  timestamp: BigInt,
  blockNumber: BigInt,
  txHash: Bytes,
): Token {
  const id = tokenEntityId(collection, tokenId);
  let token = Token.load(id);
  if (token === null) {
    token = new Token(id);
    token.tokenId = tokenId;
    token.collection = collection;
    token.owner = Bytes.fromHexString(ZERO_ADDRESS);
    token.creator = Bytes.fromHexString(ZERO_ADDRESS);
    token.name = 'Token #' + tokenId.toString();
    token.mintedAt = timestamp;
    token.mintedBlock = blockNumber;
    token.mintedTx = txHash;
    token.transferCount = ZERO_BI;
    token.updatedAt = timestamp;
  }
  return token;
}

function hydrateTokenData(token: Token): void {
  if (!token.collection.equals(PIXEL_COLLECTION)) return;

  const contract = PixelNFT.bind(PIXEL_COLLECTION);
  const result = contract.try_tokenData(token.tokenId);
  if (result.reverted) return;

  const data = result.value;
  token.name = data.getArtName().length > 0
    ? data.getArtName()
    : 'Token #' + token.tokenId.toString();
  token.gridSize = data.getGridSize();
  token.pixelData = data.getPixelData();
  token.creator = data.getCreator();
  token.creatorAccount = accountId(data.getCreator());
  token.artworkHash = data.getArtworkHash();
}

function closeActiveListingForToken(token: Token, timestamp: BigInt): void {
  const activeListingId = token.activeListing;
  if (activeListingId === null) return;

  const listing = Listing.load(activeListingId);
  if (listing === null || !listing.active) return;

  listing.active = false;
  listing.status = 'CANCELLED';
  listing.cancelledAt = timestamp;
  listing.updatedAt = timestamp;
  listing.save();

  token.activeListing = null;

  const stats = getStats(timestamp);
  stats.activeListings = stats.activeListings.gt(ZERO_BI)
    ? stats.activeListings.minus(ONE_BI)
    : ZERO_BI;
  stats.updatedAt = timestamp;
  stats.save();

  decrementAccountActiveListings(listing.seller, timestamp);
}

export function handleMinted(event: Minted): void {
  const token = getOrCreateToken(
    event.address,
    event.params.tokenId,
    event.block.timestamp,
    event.block.number,
    event.transaction.hash,
  );

  token.creator = event.params.creator;
  token.creatorAccount = accountId(event.params.creator);
  token.name = event.params.name.length > 0
    ? event.params.name
    : 'Token #' + event.params.tokenId.toString();
  token.mintedAt = event.block.timestamp;
  token.mintedBlock = event.block.number;
  token.mintedTx = event.transaction.hash;
  hydrateTokenData(token);
  token.updatedAt = event.block.timestamp;
  token.save();

  const creator = getAccount(event.params.creator, event.block.timestamp);
  creator.updatedAt = event.block.timestamp;
  creator.save();

  const stats = getStats(event.block.timestamp);
  stats.totalTokens = stats.totalTokens.plus(ONE_BI);
  stats.updatedAt = event.block.timestamp;
  stats.save();
}

export function handleTransfer(event: Transfer): void {
  const token = getOrCreateToken(
    event.address,
    event.params.tokenId,
    event.block.timestamp,
    event.block.number,
    event.transaction.hash,
  );

  if (!isZeroAddress(event.params.from)) {
    decrementAccountTokens(event.params.from, event.block.timestamp);
  }
  if (!isZeroAddress(event.params.to)) {
    incrementAccountTokens(event.params.to, event.block.timestamp);
    token.ownerAccount = accountId(event.params.to);
  } else {
    token.ownerAccount = null;
  }

  token.owner = event.params.to;
  token.transferCount = token.transferCount.plus(ONE_BI);
  hydrateTokenData(token);

  if (!isZeroAddress(event.params.from) && !event.params.from.equals(event.params.to)) {
    closeActiveListingForToken(token, event.block.timestamp);
  }

  token.updatedAt = event.block.timestamp;
  token.save();

  const transfer = new TransferEvent(eventId(event.transaction.hash, event.logIndex));
  transfer.token = token.id;
  transfer.collection = event.address;
  transfer.tokenId = event.params.tokenId;
  transfer.from = event.params.from;
  transfer.to = event.params.to;
  transfer.timestamp = event.block.timestamp;
  transfer.blockNumber = event.block.number;
  transfer.txHash = event.transaction.hash;
  transfer.save();
}

export function handleListed(event: Listed): void {
  const listingId = event.params.listingId.toString();
  const token = getOrCreateToken(
    event.params.collection,
    event.params.tokenId,
    event.block.timestamp,
    event.block.number,
    event.transaction.hash,
  );
  hydrateTokenData(token);

  closeActiveListingForToken(token, event.block.timestamp);

  let listing = Listing.load(listingId);
  if (listing === null) {
    listing = new Listing(listingId);
  }

  listing.listingId = event.params.listingId;
  listing.collection = event.params.collection;
  listing.token = token.id;
  listing.tokenId = event.params.tokenId;
  listing.seller = event.params.seller;
  listing.sellerAccount = accountId(event.params.seller);
  listing.buyer = null;
  listing.buyerAccount = null;
  listing.price = event.params.price;
  listing.active = true;
  listing.status = 'ACTIVE';
  listing.listedAt = event.block.timestamp;
  listing.listedBlock = event.block.number;
  listing.listedTx = event.transaction.hash;
  listing.soldAt = null;
  listing.soldBlock = null;
  listing.soldTx = null;
  listing.cancelledAt = null;
  listing.cancelledBlock = null;
  listing.cancelledTx = null;
  listing.updatedAt = event.block.timestamp;
  listing.save();

  token.listing = listing.id;
  token.activeListing = listing.id;
  token.updatedAt = event.block.timestamp;
  token.save();

  const seller = getAccount(event.params.seller, event.block.timestamp);
  seller.listingCount = seller.listingCount.plus(ONE_BI);
  seller.activeListingCount = seller.activeListingCount.plus(ONE_BI);
  seller.updatedAt = event.block.timestamp;
  seller.save();

  const stats = getStats(event.block.timestamp);
  stats.totalListings = stats.totalListings.plus(ONE_BI);
  stats.activeListings = stats.activeListings.plus(ONE_BI);
  stats.updatedAt = event.block.timestamp;
  stats.save();

  const marketEvent = new MarketEvent(eventId(event.transaction.hash, event.logIndex));
  marketEvent.listing = listing.id;
  marketEvent.listingId = event.params.listingId;
  marketEvent.collection = event.params.collection;
  marketEvent.tokenId = event.params.tokenId;
  marketEvent.seller = event.params.seller;
  marketEvent.buyer = null;
  marketEvent.price = event.params.price;
  marketEvent.eventType = 'LISTED';
  marketEvent.timestamp = event.block.timestamp;
  marketEvent.blockNumber = event.block.number;
  marketEvent.txHash = event.transaction.hash;
  marketEvent.save();
}

export function handleBought(event: Bought): void {
  const listingId = event.params.listingId.toString();
  const listing = Listing.load(listingId);
  if (listing === null) return;
  const wasActive = listing.active;

  listing.active = false;
  listing.status = 'SOLD';
  listing.buyer = event.params.buyer;
  listing.buyerAccount = accountId(event.params.buyer);
  listing.price = event.params.price;
  listing.soldAt = event.block.timestamp;
  listing.soldBlock = event.block.number;
  listing.soldTx = event.transaction.hash;
  listing.cancelledAt = null;
  listing.cancelledBlock = null;
  listing.cancelledTx = null;
  listing.updatedAt = event.block.timestamp;
  listing.save();

  const tokenId = listing.token;
  if (tokenId !== null) {
    const token = Token.load(tokenId);
    if (token !== null) {
      token.activeListing = null;
      token.listing = listing.id;
      token.updatedAt = event.block.timestamp;
      token.save();
    }
  }

  if (wasActive) {
    decrementAccountActiveListings(listing.seller, event.block.timestamp);
  }
  const buyer = getAccount(event.params.buyer, event.block.timestamp);
  buyer.updatedAt = event.block.timestamp;
  buyer.save();

  const stats = getStats(event.block.timestamp);
  if (wasActive) {
    stats.activeListings = stats.activeListings.gt(ZERO_BI)
      ? stats.activeListings.minus(ONE_BI)
      : ZERO_BI;
  }
  stats.totalSales = stats.totalSales.plus(ONE_BI);
  stats.totalVolume = stats.totalVolume.plus(event.params.price);
  stats.updatedAt = event.block.timestamp;
  stats.save();

  const marketEvent = new MarketEvent(eventId(event.transaction.hash, event.logIndex));
  marketEvent.listing = listing.id;
  marketEvent.listingId = event.params.listingId;
  marketEvent.collection = listing.collection;
  marketEvent.tokenId = listing.tokenId;
  marketEvent.seller = listing.seller;
  marketEvent.buyer = event.params.buyer;
  marketEvent.price = event.params.price;
  marketEvent.eventType = 'BOUGHT';
  marketEvent.timestamp = event.block.timestamp;
  marketEvent.blockNumber = event.block.number;
  marketEvent.txHash = event.transaction.hash;
  marketEvent.save();
}

export function handleListingCancelled(event: ListingCancelled): void {
  const listingId = event.params.listingId.toString();
  const listing = Listing.load(listingId);
  if (listing === null) return;

  const wasActive = listing.active;
  listing.active = false;
  listing.status = 'CANCELLED';
  listing.cancelledAt = event.block.timestamp;
  listing.cancelledBlock = event.block.number;
  listing.cancelledTx = event.transaction.hash;
  listing.updatedAt = event.block.timestamp;
  listing.save();

  const tokenId = listing.token;
  if (tokenId !== null) {
    const token = Token.load(tokenId);
    if (token !== null) {
      token.activeListing = null;
      token.listing = listing.id;
      token.updatedAt = event.block.timestamp;
      token.save();
    }
  }

  if (wasActive) {
    decrementAccountActiveListings(listing.seller, event.block.timestamp);
    const stats = getStats(event.block.timestamp);
    stats.activeListings = stats.activeListings.gt(ZERO_BI)
      ? stats.activeListings.minus(ONE_BI)
      : ZERO_BI;
    stats.updatedAt = event.block.timestamp;
    stats.save();
  }

  const marketEvent = new MarketEvent(eventId(event.transaction.hash, event.logIndex));
  marketEvent.listing = listing.id;
  marketEvent.listingId = event.params.listingId;
  marketEvent.collection = listing.collection;
  marketEvent.tokenId = listing.tokenId;
  marketEvent.seller = listing.seller;
  marketEvent.buyer = null;
  marketEvent.price = listing.price;
  marketEvent.eventType = 'CANCELLED';
  marketEvent.timestamp = event.block.timestamp;
  marketEvent.blockNumber = event.block.number;
  marketEvent.txHash = event.transaction.hash;
  marketEvent.save();
}
