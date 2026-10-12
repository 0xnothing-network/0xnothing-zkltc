import assert from "node:assert/strict";
import test from "node:test";
import { filterNusdListings, nusdArtworkKey, nusdArtworkRequests, readNusdArtwork } from "../../lib/nusdMarketplaceView.ts";

const FIRST = "0x00000000000000000000000000000000000000aA" as const;
const SECOND = "0x00000000000000000000000000000000000000bB" as const;
const SELLER = "0x00000000000000000000000000000000000000cC" as const;
const OTHER = "0x00000000000000000000000000000000000000dD" as const;
const listings = [
  { id: 1n, collection: FIRST, tokenId: 3n, price: 100000000000000000001n, seller: SELLER, active: true },
  { id: 2n, collection: FIRST, tokenId: 4n, price: 100000000000000000000n, seller: OTHER, active: true },
  { id: 3n, collection: SECOND, tokenId: 3n, price: 200000000000000000000n, seller: SELLER, active: true },
];
const defaults = { search: "", collection: "", ownOnly: false, sort: "newest" as const };

test("artwork batches are collection-aware, de-duplicated and respect the API cap of 20", () => {
  const tokens = Array.from({ length: 24 }, (_, index) => ({ collection: FIRST, tokenId: BigInt(index) }));
  const batches = nusdArtworkRequests([...tokens, ...tokens.slice(0, 3), { collection: SECOND, tokenId: 3n }]);
  assert.deepEqual(batches.map((batch) => batch.ids.length), [20, 4, 1]);
  assert.ok(batches.every((batch) => batch.url.includes(`collection=${batch.collection}`)));
  assert.equal(batches[0].collection, FIRST.toLowerCase());
  assert.notEqual(nusdArtworkKey(FIRST, 3n), nusdArtworkKey(SECOND, 3n));
  assert.equal(nusdArtworkRequests(Array.from({ length: 100 }, (_, index) => ({ collection: FIRST, tokenId: BigInt(index) }))).flatMap((batch) => batch.ids).length, 48);
});

test("catalogue metadata covers 1000 NFTs with bounded concurrent reads", async () => {
  const tokens = Array.from({ length: 1000 }, (_, index) => ({ collection: FIRST, tokenId: BigInt(index) }));
  const requests = nusdArtworkRequests(tokens, 1024);
  assert.equal(requests.length, 50);
  let active = 0, peak = 0;
  const result = await readNusdArtwork(requests, async () => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise<void>((resolve) => setImmediate(resolve));
    active -= 1;
    return { tokens: {} };
  });
  assert.equal(Object.keys(result.tokens).length, 1000);
  assert.equal(result.failed, 0);
  assert.equal(peak, 4);
  for (const limit of [-1, 1025, 1.5, NaN]) assert.throws(() => nusdArtworkRequests(tokens, limit));
});

test("metadata failure is isolated from other collections and only requested tokens are accepted", async () => {
  const requests = nusdArtworkRequests([{ collection: FIRST, tokenId: 3n }, { collection: SECOND, tokenId: 3n }]);
  const result = await readNusdArtwork(requests, async (url) => {
    if (url.includes(SECOND.toLowerCase())) throw new Error("RPC unavailable");
    return { tokens: { "3": { name: "Pixel garden" }, "4": { name: "Unrequested NFT" } } };
  });
  assert.equal(result.failed, 1);
  assert.deepEqual(result.tokens, { [nusdArtworkKey(FIRST, 3n)]: { name: "Pixel garden" } });
});

test("metadata names are bounded and missing artwork remains a display fallback", async () => {
  const result = await readNusdArtwork(nusdArtworkRequests([{ collection: FIRST, tokenId: 3n }, { collection: FIRST, tokenId: 4n }]), async () => ({ tokens: { "3": { name: "x".repeat(1000) }, "4": null } }));
  assert.equal(result.tokens[nusdArtworkKey(FIRST, 3n)]?.name.length, 200);
  assert.equal(result.tokens[nusdArtworkKey(FIRST, 4n)], null);
  assert.equal(result.failed, 0);
});

test("sorting prices uses bigint precision and never mutates chain snapshots", () => {
  const before = listings.map((listing) => listing.id);
  assert.deepEqual(filterNusdListings(listings, {}, { ...defaults, sort: "price-asc" }).map((listing) => listing.id), [2n, 1n, 3n]);
  assert.deepEqual(filterNusdListings(listings, {}, { ...defaults, sort: "price-desc" }).map((listing) => listing.id), [3n, 1n, 2n]);
  assert.deepEqual(filterNusdListings(listings, {}, defaults).map((listing) => listing.id), [3n, 2n, 1n]);
  assert.deepEqual(listings.map((listing) => listing.id), before);
});

test("search, collection and owner filters are scoped to supplied listings", () => {
  const artwork = { [nusdArtworkKey(FIRST, 3n)]: { name: "Pixel Garden" } };
  assert.deepEqual(filterNusdListings(listings, artwork, { ...defaults, search: "garden" }).map((listing) => listing.id), [1n]);
  assert.deepEqual(filterNusdListings(listings, artwork, { ...defaults, search: "#3", collection: FIRST.toLowerCase() }).map((listing) => listing.id), [1n]);
  assert.deepEqual(filterNusdListings(listings, {}, { ...defaults, ownOnly: true, address: SELLER.toLowerCase() as typeof SELLER }).map((listing) => listing.id), [3n, 1n]);
  assert.equal(filterNusdListings(listings, {}, { ...defaults, ownOnly: true }).length, 0);
  assert.equal(filterNusdListings(listings, {}, { ...defaults, search: "unlisted NFT" }).length, 0);
});
