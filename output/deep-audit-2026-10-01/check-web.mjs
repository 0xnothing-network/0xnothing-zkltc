import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const directory = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(directory, "../..");
const deployment = JSON.parse(fs.readFileSync(path.join(root,
  "0xNothing-zkLTC-Testnet/deployments/liteforge-testnet/pixel-v2.json"), "utf8"));
const base = process.argv[2] || "http://127.0.0.1:3300";
const collection = deployment.address;
const tokenId = deployment.smoke.tokenId;
const results = [];
const hash = (text) => createHash("sha256").update(text).digest("hex");
const normalizedColors = (svg) => svg.replace(/fill="#([0-9a-f]{6})"/gi,
  (_, rgb) => `fill="#${rgb.toLowerCase()}"`);

async function get(route) {
  const response = await fetch(base + route, { signal: AbortSignal.timeout(60_000) });
  const body = await response.text();
  assert.equal(response.status, 200, `${route}: ${response.status} ${body.slice(0, 250)}`);
  return { response, body };
}

const metadata = await get(`/api/token-metadata?ids=${tokenId}&collection=${collection}`);
const nft = JSON.parse(metadata.body).tokens[tokenId];
assert.equal(nft.name, "0xPixel V2 · 256");
assert.equal(nft.description, deployment.smoke.description);
assert.equal(nft.creator.toLowerCase(), deployment.deployer.toLowerCase());
assert.equal(new URL(nft.imageUrl, base).searchParams.get("collection").toLowerCase(), collection.toLowerCase());
results.push({ check: "V2 metadata", name: nft.name, description: nft.description, imageUrl: nft.imageUrl });

const image = await get(`/api/pixel-image?tokenId=${tokenId}&collection=${collection}`);
assert.match(image.response.headers.get("content-type"), /image\/svg\+xml/);
assert.match(image.body, /viewBox="0 0 256 256"/);
assert.equal((image.body.match(/<path\b/g) || []).length, 4096);
assert.equal(hash(normalizedColors(image.body)), hash(normalizedColors(fs.readFileSync(path.join(root,
  "0xNothing-zkLTC-Testnet/deployments/liteforge-testnet/pixel-v2-smoke.svg"), "utf8"))),
  "API SVG must preserve every on-chain geometry and RGB value");
const legacy = await get(`/api/pixel-image?tokenId=1`);
assert.notEqual(hash(image.body), hash(legacy.body), "Legacy #1 and V2 #1 must have distinct cached artwork");
results.push({ check: "Images and legacy cache identity", v2Bytes: Buffer.byteLength(image.body),
  v2Hash: hash(image.body), legacyHash: hash(legacy.body) });

const inventory = await get(`/api/user-nfts?address=${deployment.deployer}&force=1`);
const owned = JSON.parse(inventory.body).tokens;
assert(owned.some((item) => item.collection.toLowerCase() === collection.toLowerCase() && item.tokenId === tokenId));
const keys = owned.map((item) => `${item.collection.toLowerCase()}:${item.tokenId}`);
assert.equal(new Set(keys).size, keys.length, "Inventory must not collide by tokenId alone");
results.push({ check: "Live inventory", count: owned.length,
  collections: [...new Set(owned.map((item) => item.collection.toLowerCase()))] });

const activity = await get("/api/marketplace/activity?limit=30&skip=0");
const activityData = JSON.parse(activity.body);
const events = activityData.events;
assert(Array.isArray(events), "Activity must return an event array");
const v2MintPresent = events.some((item) => item.collection?.toLowerCase() === collection.toLowerCase()
  && item.tokenId === tokenId && item.eventType === "MINTED");
assert(v2MintPresent || activityData.partialHistory === true,
  "An older mint may be pending backfill only when the API explicitly reports partial history");
const eventKeys = events.map((item) => item.id);
assert(eventKeys.every((key) => typeof key === "string" && key.length > 0), "Activity must preserve event identifiers");
assert.equal(new Set(eventKeys).size, eventKeys.length, "Activity must not duplicate event identities");
results.push({ check: "Live activity availability and honest history status", events: events.length,
  v2MintPresent, partialHistory: activityData.partialHistory === true });

fs.writeFileSync(path.join(directory, "web-smoke.json"), JSON.stringify({ base, results }, null, 2) + "\n");
console.log(JSON.stringify({ passed: results.length, results }, null, 2));
