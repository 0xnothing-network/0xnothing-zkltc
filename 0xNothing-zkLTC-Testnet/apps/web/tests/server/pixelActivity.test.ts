import assert from "node:assert/strict";
import test from "node:test";
import { encodeAbiParameters, keccak256, toBytes } from "viem";
import { createBoundedCache } from "../../lib/boundedCache.ts";
import { getPixelImageUrl } from "../../lib/pixelImage.ts";
import { evaluateModule } from "../helpers/evaluateModule.ts";

const legacy = `0x${"1".repeat(40)}` as const;
const v2 = `0x${"2".repeat(40)}` as const;
const owner = `0x${"3".repeat(40)}` as const;
const marketplace = `0x${"4".repeat(40)}` as const;
const outsider = `0x${"5".repeat(40)}` as const;
const topic = (signature: string) => keccak256(toBytes(signature));
const uintTopic = (value: number) => `0x${BigInt(value).toString(16).padStart(64, "0")}` as const;
const addressTopic = (address: string) => `0x${address.slice(2).padStart(64, "0")}` as const;
const minted = topic("Minted(address,uint256,string)");
const listed = topic("Listed(uint256,address,uint256,address,uint256)");
const bought = topic("Bought(uint256,address,uint256)");
function log(address: string, block: number, index: number, topics: `0x${string}`[], data: `0x${string}`) {
  return { address, blockNumber: `0x${block.toString(16)}` as const, logIndex: `0x${index.toString(16)}` as const,
    transactionHash: uintTopic(block), topics, data, timeStamp: String(200 + block) };
}

test("activity recovers V2 from RPC while explorer is behind, merges history and deduplicates recent events", async () => {
  const oldMint = log(legacy, 9, 0, [minted, addressTopic(owner), uintTopic(1)], encodeAbiParameters([{ type: "string" }], ["Old Art"]));
  const newMint = log(v2, 105, 0, [minted, addressTopic(owner), uintTopic(1)], encodeAbiParameters([{ type: "string" }], ["New Art"]));
  const oldListed = log(marketplace, 101, 1, [listed, uintTopic(41), addressTopic(legacy)], encodeAbiParameters([{ type: "uint256" }, { type: "address" }, { type: "uint256" }], [1n, owner, 5n]));
  const newListed = log(marketplace, 107, 2, [listed, uintTopic(42), addressTopic(v2)], encodeAbiParameters([{ type: "uint256" }, { type: "address" }, { type: "uint256" }], [1n, owner, 7n]));
  const newBought = log(marketplace, 109, 3, [bought, uintTopic(42)], encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [owner, 7n]));
  const unindexedBought = log(marketplace, 108, 4, [bought, uintTopic(43)], encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [owner, 8n]));
  const rpcLogs = [newMint, oldListed, newListed, newBought, unindexedBought];
  const queries: Array<{ address: string; from: bigint; to: bigint }> = [];
  const blockReads = new Map<string, number>();
  let rejectedRanges = 0;
  let rejectedTimeouts = 0;
  let activeRequests = 0;
  let maxActiveRequests = 0;
  let failedExplorerReads = 0;
  let activityClient: Record<string, unknown>;
  const listingReads: string[] = [];
  const { fetchMarketplaceActivityFromOnchain } = evaluateModule<{ fetchMarketplaceActivityFromOnchain: (options: { limit: number }) => Promise<{ events: Array<{ collection: string; tokenId: string; eventType: string; timestamp: number; token: { name: string; imageUrl: string } }> }> }>(new URL("../../lib/onchainMarketplace.ts", import.meta.url), {
    viem: {
      encodeAbiParameters, keccak256, toBytes, decodeAbiParameters: (await import("viem")).decodeAbiParameters,
      http: (_url: string, options: { batch: boolean; retryCount: number; timeout: number }) => {
        assert.equal(options.batch, false);
        assert.equal(options.retryCount, 0);
        assert.equal(options.timeout, 8000);
        return "dedicated activity transport";
      },
      createPublicClient: () => activityClient,
    },
    "@/lib/pixelCollections": {
      PIXEL_COLLECTIONS: [{ address: legacy, startBlock: 5n, version: 1 }, { address: v2, startBlock: 100n, version: 2 }],
      isPixelCollection: (address: string) => address === legacy || address === v2,
      pixelTokenKey: (address: string, id: string) => `${address.toLowerCase()}:${id}`,
    },
    "@/lib/abi": { PixelNFTABI: [] },
    "@/lib/marketplaceAbi": { MarketplaceAbi: [] },
    "@/lib/contract": {
      LITVM_EXPLORER_URL: "https://explorer.test", PIXEL_MARKETPLACE_ADDRESS: marketplace, PIXEL_NFT_CONTRACT_ADDRESS: legacy,
      publicClient: (activityClient = {
        getBlockNumber: async () => 110n,
        request: async ({ params }: { params: Array<{ address: string; fromBlock: string; toBlock: string; topics: string[] }> }) => {
          activeRequests++;
          maxActiveRequests = Math.max(maxActiveRequests, activeRequests);
          try {
          await Promise.resolve();
          const query = params[0];
          const from = BigInt(query.fromBlock), to = BigInt(query.toBlock);
          queries.push({ address: query.address, from, to });
          if (to - from > 4n) { rejectedTimeouts++; throw new Error("HTTP request timed out"); }
          if (to - from > 2n) { rejectedRanges++; throw new Error("block range limit exceeded"); }
          const matches = rpcLogs.filter((entry) => entry.address === query.address && entry.topics[0] === query.topics[0] && BigInt(entry.blockNumber) >= from && BigInt(entry.blockNumber) <= to);
          // Providers must not be able to contaminate a collection's activity.
          return [...matches, ...matches.map((entry) => ({ ...entry, address: outsider })), ...matches.map((entry) => ({ ...entry, removed: true }))];
          } finally { activeRequests--; }
        },
        getBlock: async ({ blockNumber }: { blockNumber: bigint }) => {
          const key = String(blockNumber); blockReads.set(key, (blockReads.get(key) ?? 0) + 1);
          return { timestamp: 200n + blockNumber };
        },
        readContract: async ({ functionName, args }: { functionName: string; args: bigint[] }) => {
          assert.equal(functionName, "listings"); listingReads.push(String(args[0]));
          return [legacy, 9n, 8n, owner, false];
        },
        multicall: async ({ contracts }: { contracts: Array<{ address: string }> }) => contracts.map(({ address }) => ({ status: "success", result: [address === v2 ? "New Art" : "Old Art", 256n, "pixels", owner, 1n, ""] })),
      }),
    },
    "@/lib/pixelImage": { getPixelImageUrl }, "@/lib/boundedCache": { createBoundedCache },
    "@/lib/server/readLimitedJson": { readLimitedJson: (response: Response) => response.json() },
    "@/lib/publicConfig": { MARKETPLACE_START_BLOCK: 5n, LITVM_RPC_URL: "https://rpc.test" },
  }, {
    URL, AbortSignal, console: { warn() {} },
    fetch: async (url: URL) => {
      const address = url.searchParams.get("address"), filter = url.searchParams.get("topic0");
      if (address === marketplace && filter === topic("ListingCancelled(uint256)")) {
        failedExplorerReads++;
        return Response.json({}, { status: 503 });
      }
      const result = address === legacy && filter === minted ? [oldMint]
        : address === marketplace && filter === listed ? [{ ...oldListed, logIndex: "1" }] : [];
      return Response.json({ result });
    },
  });
  const { events } = await fetchMarketplaceActivityFromOnchain({ limit: 20 });
  assert.equal(events.length, 6);
  const mints = events.filter((event) => event.eventType === "MINTED");
  assert.equal(mints.length, 2);
  assert.equal(mints.find((event) => event.collection === v2)?.token.name, "New Art");
  assert.equal(mints.find((event) => event.collection === legacy)?.token.name, "Old Art");
  assert.equal(mints.find((event) => event.collection === v2)?.timestamp, 305);
  assert.equal(events.filter((event) => event.eventType === "LISTED" && event.collection === legacy).length, 1);
  assert.equal(events.find((event) => event.eventType === "BOUGHT")?.collection, v2);
  assert.ok(events.some((event) => event.eventType === "BOUGHT" && event.collection === legacy && event.tokenId === "9"));
  assert.deepEqual(listingReads, ["43"], "a recent purchase must survive an unavailable older Listed event");
  assert.ok(rejectedRanges > 0, "provider range errors must split and retain events");
  assert.ok(rejectedTimeouts > 0, "timed-out log ranges must split and retain events");
  assert.ok(maxActiveRequests <= 3, "log reads must retain bounded unbatched concurrency");
  assert.equal(activeRequests, 0);
  assert.ok(failedExplorerReads > 0, "historical explorer failure must preserve valid RPC events");
  assert.ok(queries.every((query) => query.from >= 100n && query.to <= 110n));
  assert.ok(queries.some((query) => query.address === v2));
  assert.ok(queries.some((query) => query.address === legacy));
  assert.ok(queries.some((query) => query.address === marketplace));
  assert.ok([...blockReads.values()].every((count) => count === 1));
});

test("old deployment activity keeps recent mints, reports partial history and scans incrementally", async () => {
  let head = 300_000n;
  let reorg = false;
  let failOlder = false;
  const firstMint = log(v2, 299_995, 0, [minted, addressTopic(owner), uintTopic(2)], encodeAbiParameters([{ type: "string" }], ["Recent Art"]));
  const secondMint = log(v2, 300_004, 0, [minted, addressTopic(owner), uintTopic(3)], encodeAbiParameters([{ type: "string" }], ["Latest Art"]));
  const queries: Array<{ address: string; from: bigint; to: bigint }> = [];
  const activityClient = {
    getBlockNumber: async () => head,
    request: async ({ params }: { params: Array<{ address: string; fromBlock: string; toBlock: string; topics: string[] }> }) => {
      const query = params[0], from = BigInt(query.fromBlock), to = BigInt(query.toBlock);
      queries.push({ address: query.address, from, to });
      if (failOlder && to < 295_000n) throw new Error("Archived log range unavailable");
      return (reorg ? [secondMint] : [firstMint, secondMint]).filter((entry) => query.address === entry.address && query.topics[0] === entry.topics[0]
        && BigInt(entry.blockNumber) >= from && BigInt(entry.blockNumber) <= to);
    },
    getBlock: async ({ blockNumber }: { blockNumber: bigint }) => ({ timestamp: 200n + blockNumber }),
    multicall: async ({ contracts }: { contracts: unknown[] }) => contracts.map(() => ({ status: "success", result: ["Art", 256n, "pixels", owner, 1n, ""] })),
  };
  const { fetchMarketplaceActivityFromOnchain } = evaluateModule<{ fetchMarketplaceActivityFromOnchain: () => Promise<{ events: Array<{ tokenId: string }>; partialHistory?: boolean }> }>(
    new URL("../../lib/onchainMarketplace.ts", import.meta.url), {
      viem: { encodeAbiParameters, keccak256, toBytes, decodeAbiParameters: (await import("viem")).decodeAbiParameters,
        http: () => ({}), createPublicClient: () => activityClient },
      "@/lib/pixelCollections": { PIXEL_COLLECTIONS: [{ address: v2, startBlock: 100n, version: 2 }],
        isPixelCollection: (address: string) => address === v2, pixelTokenKey: (address: string, id: string) => `${address}:${id}` },
      "@/lib/abi": { PixelNFTABI: [] },
      "@/lib/marketplaceAbi": { MarketplaceAbi: [] },
      "@/lib/contract": { LITVM_EXPLORER_URL: "https://explorer.test", PIXEL_MARKETPLACE_ADDRESS: marketplace, PIXEL_NFT_CONTRACT_ADDRESS: legacy, publicClient: activityClient },
      "@/lib/pixelImage": { getPixelImageUrl },
      // Expire only the response window to exercise the persistent scan checkpoint without sleeping.
      "@/lib/boundedCache": { createBoundedCache: (options: Parameters<typeof createBoundedCache>[0]) => createBoundedCache({ ...options, ...(options.maxEntries === 1 ? { ttlMs: 0 } : {}) }) },
      "@/lib/server/readLimitedJson": { readLimitedJson: (response: Response) => response.json() },
      "@/lib/publicConfig": { MARKETPLACE_START_BLOCK: 5n, LITVM_RPC_URL: "https://rpc.test" },
    }, { URL, AbortSignal, console: { warn() {} }, fetch: async () => Response.json({}, { status: 503 }) });
  const first = await fetchMarketplaceActivityFromOnchain();
  assert.deepEqual(Array.from(first.events, (event) => event.tokenId), ["2"]);
  assert.equal(first.partialHistory, true, "a bounded cold scan must not advertise complete history");
  assert.ok(queries.length <= 80, "cold RPC work must be bounded independently of deployment age");
  const minimumFirstBlock = queries.reduce((oldest, query) => query.from < oldest ? query.from : oldest, head);
  queries.length = 0;
  head += 5n;
  const second = await fetchMarketplaceActivityFromOnchain();
  assert.deepEqual(Array.from(second.events, (event) => event.tokenId), ["3", "2"]);
  assert.equal(second.partialHistory, true);
  assert.ok(queries.every((query) => query.from >= minimumFirstBlock - 1000n), "a warm scan must extend its checkpoint instead of restarting at deployment");
  assert.ok(queries.some((query) => query.to === head));
  reorg = true;
  const third = await fetchMarketplaceActivityFromOnchain();
  assert.deepEqual(Array.from(third.events, (event) => event.tokenId), ["3"], "the overlapping head rescan must remove orphaned events");
  failOlder = true;
  const fourth = await fetchMarketplaceActivityFromOnchain();
  assert.deepEqual(Array.from(fourth.events, (event) => event.tokenId), ["3"], "failed historical backfill must retain valid recent events");
  assert.equal(fourth.partialHistory, true);
});
