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
  static fromBytes(value) { return value; }
  toHexString() { return this.value; }
  equals(other) { return this.value === other.value; }
}

function setup(metadata = new Map(), failedPackedReads = 0) {
  const tables = new Map();
  const context = { BigInt: GraphInt, Bytes: GraphBytes, Address: GraphBytes };
  const metadataReads = [];
  context.PixelNFT = {
    bind(address) {
      metadataReads.push(address.toHexString());
      return {
        try_tokenData(id) {
          const data = metadata.get(`${address.toHexString()}-${id.toString()}`);
          return data ? {
            reverted: false,
            value: {
              getArtName: () => data.name,
              getGridSize: () => GraphInt.fromI32(data.grid),
              getPixelData: () => data.pixels,
              getCreator: () => data.creator,
              getArtworkHash: () => GraphBytes.fromHexString(`0x${'cd'.repeat(32)}`),
            },
          } : { reverted: true };
        },
        try_tokenPackedData(id) {
          if (failedPackedReads > 0) { --failedPackedReads; return { reverted: true }; }
          const data = metadata.get(`${address.toHexString()}-${id.toString()}`);
          return data ? { reverted: false, value: { getDescription: () => data.description } } : { reverted: true };
        },
      };
    },
  };
  for (const name of ['Account', 'Listing', 'MarketEvent', 'MarketplaceStats', 'Token', 'TransferEvent']) {
    const table = new Map();
    tables.set(name, table);
    context[name] = class {
      constructor(id) { this.id = id; this.activeListing = null; this.pixelData = null; this.description = null; }
      static load(id) {
        const item = table.get(id);
        return item ? Object.assign(new this(id), item) : null;
      }
      save() { table.set(this.id, { ...this }); }
    };
  }
  vm.createContext(context);
  vm.runInContext(executable, context, { timeout: 1000 });
  return { context, tables, metadataReads };
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

test('legacy and V2 tokens with the same id hydrate from their own collection and retain metadata', () => {
  const legacy = GraphBytes.fromString(source.match(/const PIXEL_COLLECTION = Address.fromString\('([^']+)'\)/)[1]);
  const v2 = GraphBytes.fromString(source.match(/const PIXEL_V2_COLLECTION = Address.fromString\('([^']+)'\)/)[1]);
  const metadata = new Map([
    [`${legacy.toHexString()}-7`, { name: 'Legacy', grid: 64, pixels: '000001ffffff', creator: seller }],
    [`${v2.toHexString()}-7`, { name: 'Large canvas', description: 'On-chain description', grid: 256, pixels: '0000ffffffff', creator: buyer }],
  ]);
  const { context, tables, metadataReads } = setup(metadata);
  context.handleMinted({ ...event({ creator: seller, tokenId, name: 'Legacy' }), address: legacy });
  context.handleMinted({ ...event({ creator: buyer, tokenId, name: 'Large canvas' }, 2), address: v2 });
  const tokens = tables.get('Token');
  assert.equal(tokens.size, 2);
  assert.equal(tokens.get(`${legacy.toHexString()}-7`).pixelData, '000001ffffff');
  const large = tokens.get(`${v2.toHexString()}-7`);
  assert.equal(large.gridSize.toString(), '256');
  assert.equal(large.description, 'On-chain description');
  assert.equal(large.creator.toHexString(), buyer.toHexString());
  assert.deepEqual(metadataReads, [legacy.toHexString(), v2.toHexString()]);
  context.handleListed(event({ listingId: GraphInt.fromI32(1), collection: v2, tokenId, seller: buyer, price: GraphInt.fromI32(50) }, 3));
  assert.equal(tables.get('Listing').get('1').token, `${v2.toHexString()}-7`);
  assert.equal(metadataReads.length, 2, 'immutable artwork metadata is reused after the mint');
});

test('manifest preserves both NFT collections and their mint/transfer handlers', () => {
  const manifest = fs.readFileSync(new URL('../subgraph.yaml', import.meta.url), 'utf8');
  const { pixel } = JSON.parse(fs.readFileSync(new URL('../../../deployments/liteforge-testnet/deployments.json', import.meta.url), 'utf8'));
  assert.match(manifest, /name: PixelNFT\s/);
  assert.match(manifest, /name: PixelNFTV2\s/);
  assert.equal((manifest.match(/handler: handleMinted/g) ?? []).length, 2);
  assert.equal((manifest.match(/handler: handleTransfer/g) ?? []).length, 2);
  const declarations = new Map([...manifest.matchAll(/name: (PixelNFT(?:V2)?)\s+network:[^\r\n]+\s+source:\s+address: "([^"]+)"\s+abi: PixelNFT\s+startBlock: (\d+)/g)]
    .map((entry) => [entry[1], { address: entry[2].toLowerCase(), startBlock: Number(entry[3]) }]));
  assert.deepEqual(declarations.get('PixelNFT'), { address: pixel.legacyNft.toLowerCase(), startBlock: pixel.legacyNftStartBlock });
  assert.deepEqual(declarations.get('PixelNFTV2'), { address: pixel.nft.toLowerCase(), startBlock: pixel.nftStartBlock });
  assert.equal(source.match(/const PIXEL_V2_COLLECTION = Address.fromString\('([^']+)'\)/)[1].toLowerCase(), pixel.nft.toLowerCase());
});

test('a safe-mint receiver forwarding the token before Minted keeps its latest owner', () => {
  const legacy = GraphBytes.fromString(source.match(/const PIXEL_COLLECTION = Address.fromString\('([^']+)'\)/)[1]);
  const v2 = GraphBytes.fromString(source.match(/const PIXEL_V2_COLLECTION = Address.fromString\('([^']+)'\)/)[1]);
  for (const address of [legacy, v2]) {
    const metadata = new Map([
      [`${address.toHexString()}-7`, { name: 'Forwarded', description: 'Immutable', grid: 8, pixels: '000001ffffff', creator: seller }],
    ]);
    const { context, tables } = setup(metadata);
    const zero = GraphBytes.fromString('0x0000000000000000000000000000000000000000');
    context.handleTransfer({ ...event({ from: zero, to: seller, tokenId }), address });
    context.handleTransfer({ ...event({ from: seller, to: buyer, tokenId }, 2), address });
    context.handleMinted({ ...event({ creator: seller, tokenId, name: 'Forwarded' }, 3), address });
    const token = tables.get('Token').get(`${address.toHexString()}-7`);
    assert.equal(token.owner.toHexString(), buyer.toHexString());
    assert.equal(token.ownerAccount, buyer.toHexString());
    assert.equal(token.creator.toHexString(), seller.toHexString());
    assert.equal(token.transferCount.toString(), '2');
    assert.equal(tables.get('Account').get(seller.toHexString()).tokenCount.toString(), '0');
    assert.equal(tables.get('Account').get(buyer.toHexString()).tokenCount.toString(), '1');
    assert.equal(tables.get('MarketplaceStats').get('global').totalTokens.toString(), '1');
  }
});

test('a transient V2 description read retries even when artwork is already indexed', () => {
  const address = GraphBytes.fromString(source.match(/const PIXEL_V2_COLLECTION = Address.fromString\('([^']+)'\)/)[1]);
  const metadata = new Map([
    [`${address.toHexString()}-7`, { name: 'Retry', description: 'Recovered description', grid: 128, pixels: '000001ffffff', creator: seller }],
  ]);
  const { context, tables, metadataReads } = setup(metadata, 1);
  context.handleMinted({ ...event({ creator: seller, tokenId, name: 'Retry' }), address });
  const key = `${address.toHexString()}-7`;
  assert.equal(tables.get('Token').get(key).description, null);
  assert.equal(tables.get('Token').get(key).pixelData, '000001ffffff');
  context.handleTransfer({ ...event({ from: seller, to: buyer, tokenId }, 2), address });
  assert.equal(tables.get('Token').get(key).description, 'Recovered description');
  assert.equal(metadataReads.length, 2);
});
