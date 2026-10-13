import { BigInt, Bytes, ethereum } from '@graphprotocol/graph-ts';
import { NusdActivity, NusdListing, NusdMarketStats, NusdOffer } from '../generated/schema';
import {
  Bought,
  Listed,
  ListingCancelled,
  ListingInvalidated,
  ListingPriceUpdated,
  OfferAccepted,
  OfferCancelled,
  OfferCreated,
  SaleSettled,
} from '../generated/NusdNftMarketplace/NusdNftMarketplace';
import { Transfer } from '../generated/PixelNFT/ERC721';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const STATS_ID = 'global';
const ZERO_BI = BigInt.fromI32(0);
const ONE_BI = BigInt.fromI32(1);
// 2^32: log indexes are far below this, so blockNumber * 2^32 + logIndex orders like (block, index).
const LOG_INDEX_SPAN = BigInt.fromString('4294967296');

function stats(event: ethereum.Event): NusdMarketStats {
  let entity = NusdMarketStats.load(STATS_ID);
  if (entity == null) {
    entity = new NusdMarketStats(STATS_ID);
    entity.listings = ZERO_BI;
    entity.sales = ZERO_BI;
    entity.volume = ZERO_BI;
    entity.offers = ZERO_BI;
  }
  entity.updatedAt = event.block.timestamp;
  return entity;
}

function activity(event: ethereum.Event, type: string, collection: Bytes, tokenId: BigInt, actor: Bytes, price: BigInt | null): NusdActivity {
  const entity = new NusdActivity(event.transaction.hash.toHexString() + '-' + event.logIndex.toString());
  entity.type = type;
  entity.collection = collection;
  entity.tokenId = tokenId;
  entity.actor = actor;
  entity.price = price;
  entity.blockNumber = event.block.number;
  entity.logIndex = event.logIndex;
  entity.sortKey = event.block.number.times(LOG_INDEX_SPAN).plus(event.logIndex);
  entity.timestamp = event.block.timestamp;
  entity.transactionHash = event.transaction.hash;
  return entity;
}

function closeListing(id: BigInt, status: string, event: ethereum.Event): NusdListing | null {
  const listing = NusdListing.load(id.toString());
  if (listing == null) return null;
  listing.status = status;
  listing.updatedAt = event.block.timestamp;
  listing.save();
  return listing;
}

export function handleListed(event: Listed): void {
  const listing = new NusdListing(event.params.listingId.toString());
  listing.collection = event.params.collection;
  listing.tokenId = event.params.tokenId;
  listing.seller = event.params.seller;
  listing.price = event.params.price;
  listing.status = 'ACTIVE';
  listing.listedAt = event.block.timestamp;
  listing.updatedAt = event.block.timestamp;
  listing.save();
  const totals = stats(event);
  totals.listings = totals.listings.plus(ONE_BI);
  totals.save();
  activity(event, 'LISTED', event.params.collection, event.params.tokenId, event.params.seller, event.params.price).save();
}

export function handleListingPriceUpdated(event: ListingPriceUpdated): void {
  const listing = NusdListing.load(event.params.listingId.toString());
  if (listing == null) return;
  listing.price = event.params.price;
  listing.updatedAt = event.block.timestamp;
  listing.save();
  activity(event, 'UPDATED', listing.collection, listing.tokenId, listing.seller, event.params.price).save();
}

export function handleListingCancelled(event: ListingCancelled): void {
  const listing = closeListing(event.params.listingId, 'CANCELLED', event);
  if (listing != null) activity(event, 'CANCELLED', listing.collection, listing.tokenId, listing.seller, listing.price).save();
}

export function handleListingInvalidated(event: ListingInvalidated): void {
  const listing = closeListing(event.params.listingId, 'INVALIDATED', event);
  if (listing != null) activity(event, 'CANCELLED', listing.collection, listing.tokenId, listing.seller, listing.price).save();
}

export function handleBought(event: Bought): void {
  const listing = closeListing(event.params.listingId, 'SOLD', event);
  if (listing == null) return;
  listing.buyer = event.params.buyer;
  listing.save();
}

// One SaleSettled per sale, for both purchases and accepted offers.
export function handleSaleSettled(event: SaleSettled): void {
  const sale = activity(event, 'BOUGHT', event.params.collection, event.params.tokenId, event.params.seller, event.params.price);
  sale.other = event.params.buyer;
  sale.save();
  const totals = stats(event);
  totals.sales = totals.sales.plus(ONE_BI);
  totals.volume = totals.volume.plus(event.params.price);
  totals.save();
}

export function handleOfferCreated(event: OfferCreated): void {
  const offer = new NusdOffer(event.params.offerId.toString());
  offer.collection = event.params.collection;
  offer.tokenId = event.params.tokenId;
  offer.offerer = event.params.offerer;
  offer.price = event.params.price;
  offer.expiresAt = event.params.expiresAt;
  offer.status = 'ACTIVE';
  offer.createdAt = event.block.timestamp;
  offer.updatedAt = event.block.timestamp;
  offer.save();
  const totals = stats(event);
  totals.offers = totals.offers.plus(ONE_BI);
  totals.save();
  activity(event, 'OFFER_CREATED', event.params.collection, event.params.tokenId, event.params.offerer, event.params.price).save();
}

export function handleOfferCancelled(event: OfferCancelled): void {
  const offer = NusdOffer.load(event.params.offerId.toString());
  if (offer == null) return;
  offer.status = 'REFUNDED';
  offer.updatedAt = event.block.timestamp;
  offer.save();
  activity(event, 'OFFER_REFUNDED', offer.collection, offer.tokenId, event.params.offerer, event.params.refund).save();
}

export function handleOfferAccepted(event: OfferAccepted): void {
  const offer = NusdOffer.load(event.params.offerId.toString());
  if (offer == null) return;
  offer.status = 'ACCEPTED';
  offer.updatedAt = event.block.timestamp;
  offer.save();
}

export function handleTransfer(event: Transfer): void {
  if (event.params.from.toHexString() != ZERO_ADDRESS) return;
  activity(event, 'MINTED', event.address, event.params.tokenId, event.params.to, null).save();
}
