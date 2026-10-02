import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import dotenv from 'dotenv';

dotenv.config({ path: new URL('../.env.local', import.meta.url), quiet: true });

const endpoint = process.env.SUBGRAPH_URL;
assert.ok(endpoint, 'Set SUBGRAPH_URL in .env.local before running live verification.');
const website = new URL(process.env.SUBGRAPH_TEST_WEB_URL || 'http://localhost:3300/DOGEOSxPIXEL/');
const limit = 48;
const checks = [];

async function requestJson(url, options = {}, label = 'Request') {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(45000) });
  assert.ok(response.ok, `${label} returned HTTP ${response.status}.`);
  return response.json();
}

async function graph(query, variables = {}) {
  const result = await requestJson(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  }, 'Goldsky GraphQL');
  assert.ok(!result.errors?.length, 'Goldsky returned GraphQL errors.');
  assert.ok(result.data, 'Goldsky returned no data.');
  assert.equal(result.data._meta.hasIndexingErrors, false, 'The subgraph has indexing errors.');
  assert.ok(result.data._meta.block.number > 0, 'The subgraph has not indexed a block.');
  return result.data;
}

function api(path, params = {}) {
  const url = new URL(`api/${path}`, website);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
  return requestJson(url, {}, `Website ${path}`);
}

const snapshotQuery = `query LiveVerification($first: Int!) {
  _meta { block { number hash } hasIndexingErrors }
  pixels(first:$first,orderBy:tokenId,orderDirection:desc) {
    id tokenId name grid artworkHash owner creator tokenApproved ownerApproval { approved } collection { id }
    listing { id seller price expiry status }
  }
  collections(first:100,orderBy:createdAt,orderDirection:desc) { id owner name description pixelCount }
  stats(id:"global") { minted collections sales volume royalties fees }
  listings(first:100,orderBy:createdAt,orderDirection:desc) { id status price expiry pixel { id } }
  offers(first:100,orderBy:createdAt,orderDirection:desc) { id status amount pixel { id } }
  sales(first:100,orderBy:timestamp,orderDirection:desc) { id price royalty fee kind pixel { id } }
  accounts(first:100) { id credits }
  activities(first:40,orderBy:timestamp,orderDirection:desc) { id kind block }
}`;

const [indexed, catalog, status] = await Promise.all([
  graph(snapshotQuery, { first: limit }),
  api('catalog', { limit }),
  api('status'),
]);

assert.equal(status.subgraphConfigured, true, 'The website has no subgraph endpoint configured.');
assert.equal(catalog.source, 'subgraph', 'The website is falling back to its RPC index.');
assert.ok(indexed.stats, 'The subgraph has not indexed its Stats entity.');
assert.ok(BigInt(indexed.stats.minted) > 0n, 'The subgraph has not indexed any minted NFTs.');
assert.equal(BigInt(indexed.stats.minted), BigInt(status.supply), 'Minted count differs from the website chain index.');
assert.equal(BigInt(indexed.stats.minted), BigInt(catalog.supply), 'Catalogue supply differs from the subgraph.');
assert.equal(BigInt(indexed.stats.collections), BigInt(status.collectionCount), 'Collection count differs from the website chain index.');
assert.deepEqual(catalog.tokens.map(token => token.id), indexed.pixels.map(pixel => pixel.id), 'Catalogue token discovery differs from Goldsky.');

for (const [position, token] of catalog.tokens.entries()) {
  const pixel = indexed.pixels[position];
  assert.equal(pixel.tokenId, token.id);
  assert.equal(pixel.name, token.name);
  assert.equal(pixel.grid, token.grid);
  assert.equal(pixel.artworkHash.toLowerCase(), token.artworkHash.toLowerCase());
  assert.equal(pixel.owner.toLowerCase(), token.owner.toLowerCase(), `Owner differs for NFT ${token.id}.`);
  assert.equal(pixel.creator.toLowerCase(), token.creator.toLowerCase());
  assert.equal(pixel.collection?.id || '0', token.collectionId);
  const active = pixel.listing?.status === 'ACTIVE' && (pixel.tokenApproved || pixel.ownerApproval.approved) && BigInt(pixel.listing.expiry) > BigInt(Math.floor(Date.now() / 1000));
  assert.equal(Boolean(active), Boolean(token.listing), `Active listing differs for NFT ${token.id}.`);
  if (token.listing) {
    assert.equal(pixel.listing.id, token.listing.id);
    assert.equal(pixel.listing.seller.toLowerCase(), token.listing.seller.toLowerCase());
    assert.equal(pixel.listing.price, token.listing.price);
    assert.equal(BigInt(pixel.listing.expiry), BigInt(token.listing.expiry));
  }
}
checks.push('Healthy index, minted and collection counts, discovery, metadata, owners, membership, and active listings match chain-validated website data.');

const webCollections = new Map(catalog.collections.map(collection => [collection.id, collection]));
for (const collection of indexed.collections) {
  const actual = webCollections.get(collection.id);
  assert.ok(actual, `Collection ${collection.id} is missing from the website.`);
  assert.equal(collection.owner.toLowerCase(), actual.owner.toLowerCase());
  assert.equal(collection.name, actual.name);
  assert.equal(collection.description, actual.description);
  assert.equal(collection.pixelCount, actual.count);
}
assert.deepEqual([...webCollections.keys()].sort(), indexed.collections.map(collection => collection.id).sort());
for (const offer of indexed.offers) assert.ok(BigInt(offer.amount) > 0n);
for (const account of indexed.accounts) assert.ok(BigInt(account.credits) >= 0n);
if (BigInt(indexed.stats.sales) <= 100n) {
  assert.equal(BigInt(indexed.stats.sales), BigInt(indexed.sales.length));
  for (const [field, stat] of [['price', 'volume'], ['royalty', 'royalties'], ['fee', 'fees']]) {
    assert.equal(indexed.sales.reduce((sum, sale) => sum + BigInt(sale[field]), 0n), BigInt(indexed.stats[stat]));
  }
}
checks.push('Collection metadata and counts, sale totals, positive offer amounts, and nonnegative account credits are consistent.');

const filteredQuery = `query FilterVerification($where: Pixel_filter!, $first: Int!) {
  _meta { block { number } hasIndexingErrors }
  pixels(first:$first,where:$where,orderBy:tokenId,orderDirection:desc) { id }
}`;
const sample = indexed.pixels[0];
const filterCases = [
  { label: 'owner', params: { owner: sample.owner }, where: { owner: sample.owner.toLowerCase() } },
  { label: 'search', params: { search: sample.name }, where: { name_contains_nocase: sample.name } },
  { label: 'listed', params: { listed: 'true' }, where: { or:[{listing_: { status: 'ACTIVE', expiry_gt: String(Math.floor(Date.now() / 1000)) },tokenApproved:true},{listing_: { status: 'ACTIVE', expiry_gt: String(Math.floor(Date.now() / 1000)) },ownerApproval_:{approved:true}}] } },
];
const collection = sample.collection?.id || indexed.collections[0]?.id;
if (collection) filterCases.push({ label: 'collection', params: { collection }, where: { collection } });
const filters = [];
for (const test of filterCases) {
  const [expected, actual] = await Promise.all([
    graph(filteredQuery, { where: test.where, first: limit }),
    api('catalog', { ...test.params, limit }),
  ]);
  assert.equal(actual.source, 'subgraph', `${test.label} filter fell back to RPC.`);
  assert.deepEqual(actual.tokens.map(token => token.id), expected.pixels.map(pixel => pixel.id), `${test.label} filter discovery differs from Goldsky.`);
  if (expected.pixels.length < limit) assert.equal(actual.total, expected.pixels.length, `${test.label} filter count differs from the chain index.`);
  filters.push({ filter: test.label, returned: actual.tokens.length, total: actual.total, source: actual.source });
}
checks.push('Owner, name search, listed, and available collection filters use Goldsky and match its results.');

const publicEndpoint = new URL(endpoint);
publicEndpoint.username = '';
publicEndpoint.password = '';
for (const key of [...publicEndpoint.searchParams.keys()]) publicEndpoint.searchParams.set(key, '[redacted]');
const evidence = {
  passed: true,
  verifiedAt: new Date().toISOString(),
  endpoint: publicEndpoint.toString(),
  website: website.toString(),
  meta: indexed._meta,
  websiteIndexedBlock: catalog.indexedBlock,
  stats: indexed.stats,
  samples: {
    pixels: indexed.pixels.length,
    collections: indexed.collections.length,
    listings: indexed.listings.length,
    offers: indexed.offers.length,
    sales: indexed.sales.length,
    accounts: indexed.accounts.length,
    activities: indexed.activities.length,
  },
  filters,
  checks,
};
await mkdir(new URL('../output/', import.meta.url), { recursive: true });
await writeFile(new URL('../output/subgraph-live.json', import.meta.url), JSON.stringify(evidence, null, 2) + '\n');
console.log(`Live Goldsky verification passed at block ${indexed._meta.block.number}; website discovery source: ${catalog.source}.`);
