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
  plus(other) { return new GraphInt(this.value + other.value); }
  minus(other) { return new GraphInt(this.value - other.value); }
  gt(other) { return this.value > other.value; }
  toString() { return this.value.toString(); }
}

class GraphBytes {
  constructor(value) { this.value = value.toLowerCase(); }
  static fromHexString(value) { return new GraphBytes(value); }
  static fromString(value) { return new GraphBytes(value); }
  toHexString() { return this.value; }
  equals(other) { return this.value === other.value; }
}

function setup() {
  const tables = new Map();
  const context = { BigInt: GraphInt, Bytes: GraphBytes, Address: GraphBytes };
  for (const name of ['Account', 'Listing', 'MarketEvent', 'MarketplaceStats', 'Token', 'TransferEvent']) {
    const table = new Map();
    tables.set(name, table);
    context[name] = class {
      constructor(id) { this.id = id; this.activeListing = null; }
      static load(id) {
        const item = table.get(id);
        return item ? Object.assign(new this(id), item) : null;
      }
      save() { table.set(this.id, { ...this }); }
    };
  }
  vm.createContext(context);
  vm.runInContext(executable, context, { timeout: 1000 });
  return { context, tables };
}

const collection = GraphBytes.fromString('0x0000000000000000000000000000000000000011');
const seller = GraphBytes.fromString('0x0000000000000000000000000000000000000022');
const buyer = GraphBytes.fromString('0x0000000000000000000000000000000000000033');
const tokenId = GraphInt.fromI32(7);
const tokenKey = `${collection.toHexString()}-7`;
const txHash = GraphBytes.fromHexString(`0x${'ab'.repeat(32)}`);

function event(params, index = 1) {
  return {
    address: collection,
    params,
    block: { timestamp: GraphInt.fromI32(100 + index), number: GraphInt.fromI32(10) },
    transaction: { hash: txHash },
    logIndex: GraphInt.fromI32(index),
  };
}

function list(context) {
  context.handleListed(event({ listingId: GraphInt.fromI32(1), collection, tokenId, seller, price: GraphInt.fromI32(50) }));
}

test('revoked approval followed by invalidation closes the indexed listing', () => {
  const { context, tables } = setup();
  list(context);
  assert.equal(typeof context.handleListingInvalidated, 'function');
  context.handleListingInvalidated(event({ listingId: GraphInt.fromI32(1) }, 2));
  const listing = tables.get('Listing').get('1');
  assert.equal(listing.active, false);
  assert.equal(listing.status, 'CANCELLED');
  assert.equal(listing.cancelledAt.toString(), '102');
  assert.equal(tables.get('Token').get(tokenKey).activeListing, null);
  assert.equal(tables.get('Account').get(seller.toHexString()).activeListingCount.toString(), '0');
  assert.equal(tables.get('MarketplaceStats').get('global').activeListings.toString(), '0');
  assert.equal(tables.get('MarketEvent').get(`${txHash.toHexString()}-2`).eventType, 'CANCELLED');
});

test('invalidation after an observed transfer does not decrement another active listing', () => {
  const { context, tables } = setup();
  list(context);
  context.handleListed(event({ listingId: GraphInt.fromI32(2), collection, tokenId: GraphInt.fromI32(8), seller, price: GraphInt.fromI32(50) }, 2));
  context.handleTransfer(event({ from: seller, to: buyer, tokenId }, 3));
  context.handleListingInvalidated(event({ listingId: GraphInt.fromI32(1) }, 4));
  assert.equal(tables.get('MarketplaceStats').get('global').activeListings.toString(), '1');
  assert.equal(tables.get('Account').get(seller.toHexString()).activeListingCount.toString(), '1');
  assert.equal(tables.get('Listing').get('2').active, true);
});

test('ordinary cancellation keeps its existing accounting', () => {
  const { context, tables } = setup();
  list(context);
  context.handleListingCancelled(event({ listingId: GraphInt.fromI32(1) }, 2));
  assert.equal(tables.get('Listing').get('1').status, 'CANCELLED');
  assert.equal(tables.get('MarketplaceStats').get('global').activeListings.toString(), '0');
});

test('manifest subscribes to the invalidation event', () => {
  const manifest = fs.readFileSync(new URL('../subgraph.yaml', import.meta.url), 'utf8');
  assert.match(manifest, /event: ListingInvalidated\(indexed uint256\)\s+handler: handleListingInvalidated/);
});
