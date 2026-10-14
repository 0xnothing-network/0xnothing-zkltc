import assert from 'node:assert/strict';
import fs from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { test } from 'node:test';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../src/mapping.ts', import.meta.url), 'utf8');
const executable = stripTypeScriptTypes(source)
  .replace(/^import\s+[\s\S]*?\s+from\s+['"][^'"]+['"];\s*/gm, '')
  .replace(/^export /gm, '');

class GraphInt {
  constructor(value) { this.value = BigInt(value); }
  static fromI32(value) { return new GraphInt(value); }
  static fromString(value) { return new GraphInt(value); }
  plus(other) { return new GraphInt(this.value + other.value); }
  times(other) { return new GraphInt(this.value * other.value); }
  toString() { return this.value.toString(); }
}

class GraphBytes {
  constructor(value) { this.value = value.toLowerCase(); }
  toHexString() { return this.value; }
}

const MARKET = new GraphBytes('0xa5e3edfcba3b6fc40f3e41557f8a303a2aac7e09');
const NFT = new GraphBytes('0xd83cb7acef921f98b6b983cbb712a583869da9eb');
const SELLER = new GraphBytes('0x0000000000000000000000000000000000000055');
const BUYER = new GraphBytes('0x0000000000000000000000000000000000000066');
const ZERO = new GraphBytes('0x0000000000000000000000000000000000000000');
const UNIT = 10n ** 18n;

function setup() {
  const tables = new Map();
  const context = { BigInt: GraphInt };
  for (const name of ['NusdActivity', 'NusdListing', 'NusdMarketStats', 'NusdOffer']) {
    const table = new Map();
    tables.set(name, table);
    context[name] = class {
      constructor(id) { this.id = id; this.other = null; this.buyer = null; }
      static load(id) {
        const item = table.get(id);
        return item ? Object.assign(new this(id), item) : null;
      }
      save() { table.set(this.id, { ...this }); }
    };
  }
  vm.createContext(context);
  vm.runInContext(executable, context, { timeout: 1000 });
  let log = 0;
  const event = (params, { block = 100, address = MARKET } = {}) => ({
    params,
    address,
    logIndex: GraphInt.fromI32(log++),
    block: { number: GraphInt.fromI32(block), timestamp: GraphInt.fromI32(1_700_000_000 + block) },
    transaction: { hash: new GraphBytes(`0x${'ab'.repeat(32)}`) },
  });
  const rows = (name) => Array.from(tables.get(name).values());
  return { context, event, rows, tables };
}

const big = (value) => new GraphInt(value);

test('listing lifecycle records price edits, the sale and volume once per settlement', () => {
  const { context, event, rows, tables } = setup();
  context.handleListed(event({ listingId: big(1), collection: NFT, tokenId: big(7), seller: SELLER, price: big(10n * UNIT) }));
  context.handleListingPriceUpdated(event({ listingId: big(1), price: big(12n * UNIT) }));
  context.handleSaleSettled(event({ seller: SELLER, buyer: BUYER, collection: NFT, tokenId: big(7), price: big(12n * UNIT), burned: big(12n * UNIT / 1000n), creator: SELLER, creatorFee: big(48n * UNIT / 1000n) }));
  context.handleBought(event({ listingId: big(1), buyer: BUYER, price: big(12n * UNIT) }));
  const listing = tables.get('NusdListing').get('1');
  assert.equal(listing.status, 'SOLD');
  assert.equal(listing.price.toString(), (12n * UNIT).toString());
  assert.equal(listing.buyer.toHexString(), BUYER.toHexString());
  const activity = rows('NusdActivity');
  assert.deepEqual(activity.map((row) => row.type), ['LISTED', 'UPDATED', 'BOUGHT']);
  assert.equal(activity[1].actor.toHexString(), SELLER.toHexString());
  assert.equal(activity[2].other.toHexString(), BUYER.toHexString());
  const stats = tables.get('NusdMarketStats').get('global');
  assert.equal(stats.sales.toString(), '1');
  assert.equal(stats.volume.toString(), (12n * UNIT).toString());
  assert.equal(stats.burned.toString(), (12n * UNIT / 1000n).toString());
});

test('cancellation and invalidation both surface as CANCELLED with the listing identity', () => {
  const { context, event, rows, tables } = setup();
  context.handleListed(event({ listingId: big(1), collection: NFT, tokenId: big(7), seller: SELLER, price: big(5) }));
  context.handleListed(event({ listingId: big(2), collection: NFT, tokenId: big(8), seller: SELLER, price: big(6) }));
  context.handleListingCancelled(event({ listingId: big(1) }));
  context.handleListingInvalidated(event({ listingId: big(2) }));
  context.handleListingCancelled(event({ listingId: big(99) }));
  assert.equal(tables.get('NusdListing').get('1').status, 'CANCELLED');
  assert.equal(tables.get('NusdListing').get('2').status, 'INVALIDATED');
  const cancelled = rows('NusdActivity').filter((row) => row.type === 'CANCELLED');
  assert.deepEqual(cancelled.map((row) => [row.tokenId.toString(), row.price.toString()]), [['7', '5'], ['8', '6']]);
});

test('offers track escrow refunds and acceptance; refunds belong to the offerer', () => {
  const { context, event, rows, tables } = setup();
  context.handleOfferCreated(event({ offerId: big(3), collection: NFT, tokenId: big(9), offerer: BUYER, price: big(80), expiresAt: big(1_800_000_000) }));
  context.handleOfferCreated(event({ offerId: big(4), collection: NFT, tokenId: big(9), offerer: BUYER, price: big(90), expiresAt: big(1_800_000_000) }));
  context.handleOfferCancelled(event({ offerId: big(3), offerer: BUYER, refund: big(80) }));
  context.handleOfferAccepted(event({ offerId: big(4), seller: SELLER, buyer: BUYER, price: big(90) }));
  assert.equal(tables.get('NusdOffer').get('3').status, 'REFUNDED');
  assert.equal(tables.get('NusdOffer').get('4').status, 'ACCEPTED');
  const refund = rows('NusdActivity').find((row) => row.type === 'OFFER_REFUNDED');
  assert.equal(refund.actor.toHexString(), BUYER.toHexString());
  assert.equal(refund.tokenId.toString(), '9');
  assert.equal(refund.price.toString(), '80');
  assert.equal(tables.get('NusdMarketStats').get('global').offers.toString(), '2');
});

test('only mints from both collections become MINTED activity', () => {
  const { context, event, rows } = setup();
  context.handleTransfer(event({ from: ZERO, to: SELLER, tokenId: big(11) }, { address: NFT }));
  context.handleTransfer(event({ from: SELLER, to: BUYER, tokenId: big(11) }, { address: NFT }));
  const minted = rows('NusdActivity');
  assert.equal(minted.length, 1);
  assert.equal(minted[0].type, 'MINTED');
  assert.equal(minted[0].collection.toHexString(), NFT.toHexString());
  assert.equal(minted[0].price, null);
});

test('sort keys order activity by block, then log index', () => {
  const { context, event, rows } = setup();
  context.handleTransfer(event({ from: ZERO, to: SELLER, tokenId: big(1) }, { address: NFT, block: 200 }));
  context.handleTransfer(event({ from: ZERO, to: SELLER, tokenId: big(2) }, { address: NFT, block: 199 }));
  const keys = rows('NusdActivity').map((row) => row.sortKey.value);
  assert.equal(keys[0], 200n * 2n ** 32n + 0n);
  assert.equal(keys[1], 199n * 2n ** 32n + 1n);
  assert.ok(keys[0] > keys[1]);
});
