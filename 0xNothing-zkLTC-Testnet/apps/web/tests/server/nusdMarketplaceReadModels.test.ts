import assert from "node:assert/strict";
import test from "node:test";
import * as viem from "viem";
import * as marketplace from "../../lib/nusdMarketplace.ts";
import type { readNusdMarketActivity, NusdActivityFilter } from "../../lib/nusdMarketplaceActivity.ts";
import type { readNusdWalletListings } from "../../lib/nusdMarketplaceInventory.ts";
import { evaluateModule } from "../helpers/evaluateModule.ts";

const MARKET = "0x0000000000000000000000000000000000000011" as const;
const NUSD = "0x0000000000000000000000000000000000000022" as const;
const NFT = "0x0000000000000000000000000000000000000033" as const;
const OTHER_NFT = "0x0000000000000000000000000000000000000044" as const;
const SELLER = "0x0000000000000000000000000000000000000055" as const;
const BUYER = "0x0000000000000000000000000000000000000066" as const;
const HASH = `0x${"ab".repeat(32)}` as const;
const activityModule = evaluateModule<{ readNusdMarketActivity: typeof readNusdMarketActivity; parseNusdActivityCursor: (value: string | null) => unknown }>(new URL("../../lib/nusdMarketplaceActivity.ts", import.meta.url), { viem, "./nusdMarketplace": marketplace }, { Error });
const inventoryModule = evaluateModule<{ readNusdWalletListings: typeof readNusdWalletListings }>(new URL("../../lib/nusdMarketplaceInventory.ts", import.meta.url), { "./nusdMarketplace": marketplace }, { Error });
type Log = { address: viem.Address; eventName: string; args: Record<string, unknown>; blockNumber: bigint | null; logIndex: number; transactionHash: viem.Hex; removed?: boolean };
function log(eventName: string, index: number, args: Record<string, unknown>, address: viem.Address = MARKET): Log {
  return { address, eventName, args, blockNumber: 10000n, logIndex: index, transactionHash: HASH };
}
function reader(options: { logs?: Log[]; chainId?: number; token?: viem.Address; marker?: string; latest?: bigint; badTimestamp?: boolean } = {}) {
  const calls: { functionName: string; blockNumber?: bigint }[] = [];
  const windows: { fromBlock: bigint; toBlock: bigint; address: viem.Address | viem.Address[] }[] = [];
  const client = {
    getChainId: async () => options.chainId ?? 4441,
    getBlock: async ({ blockNumber }: { blockNumber?: bigint }) => ({ number: blockNumber ?? options.latest ?? 10000n, timestamp: options.badTimestamp ? 8_640_000_000_001n : 1700000000n }),
    readContract: async (call: typeof calls[number]) => {
      calls.push(call);
      if (call.functionName === "nusd") return options.token ?? NUSD;
      if (call.functionName === "IMPLEMENTATION_ID") return options.marker ?? marketplace.NUSD_MARKET_IMPLEMENTATION;
      if (call.functionName === "listings") return [NFT, 3n, 100n, SELLER, false];
      if (call.functionName === "offers") return [NFT, 3n, BUYER, 80n, 100n, false];
      throw new Error("Unexpected contract read");
    },
    getLogs: async (window: typeof windows[number]) => {
      windows.push(window);
      return (options.logs ?? []).filter((entry) => entry.blockNumber !== null && entry.blockNumber >= window.fromBlock && entry.blockNumber <= window.toBlock && (Array.isArray(window.address) ? entry.address === NFT : entry.address !== NFT));
    },
  } as unknown as Parameters<typeof readNusdMarketActivity>[0];
  const read = (cursor?: string, filter: NusdActivityFilter = "ALL", limit = 24, deploymentBlock = 9999n) => activityModule.readNusdMarketActivity(client, { market: MARKET, nusd: NUSD, collections: [NFT], deploymentBlock, cursor, filter, limit });
  return { client, read, calls, windows };
}

test("NUSD history verifies chain, token, marker and mined timestamps before logs", async () => {
  for (const options of [{ chainId: 1 }, { token: NFT }, { marker: "0x00" }, { badTimestamp: true }]) {
    const history = reader(options);
    await assert.rejects(history.read());
    assert.equal(history.windows.length, 0);
  }
  const future = reader();
  await assert.rejects(future.read("10001:0"), /block/);
  assert.equal(future.windows.length, 0);
  for (const cursor of ["-1:0", "1:-1", "a:0", "1:2147483648", `${1n << 256n}:0`, "9".repeat(79) + ":0"]) assert.throws(() => activityModule.parseNusdActivityCursor(cursor));
});

test("NUSD history paginates within blocks, deduplicates settlements and never relabels native trades", async () => {
  const native = log("SaleSettled", 20, { collection: NFT, tokenId: 3n, seller: SELLER, buyer: BUYER, price: 900n }, OTHER_NFT);
  const sale = log("SaleSettled", 9, { collection: NFT, tokenId: 3n, seller: SELLER, buyer: BUYER, price: 1000000000000000001n });
  const listing = log("Listed", 8, { collection: NFT, tokenId: 3n, seller: SELLER, price: 100n });
  const mint = log("Transfer", 7, { from: viem.zeroAddress, to: SELLER, tokenId: 3n }, NFT);
  const history = reader({ logs: [sale, native, sale, listing, mint, { ...listing, logIndex: 6, removed: true }] });
  const page = await history.read(undefined, "ALL", 2);
  assert.deepEqual(Array.from(page.events, (event) => event.type), ["BOUGHT", "LISTED"]);
  assert.equal(page.events[0].price, "1000000000000000001");
  assert.equal(page.nextCursor, "10000:8");
  const older = await history.read(page.nextCursor!, "ALL", 2);
  assert.equal(older.events.length, 1);
  assert.equal(older.events[0].type, "MINTED");
  assert.equal(older.events[0].price, null);
  assert.equal(older.nextCursor, null);
  assert.ok(history.calls.every((call) => call.blockNumber === 10000n));
});

test("NUSD history preserves price edits, cancellations and escrow refunds with on-chain identities", async () => {
  const history = reader({ logs: [
    log("ListingPriceUpdated", 9, { listingId: 1n, price: 120n }),
    log("ListingCancelled", 8, { listingId: 1n }),
    log("OfferCancelled", 7, { offerId: 2n, offerer: BUYER, refund: 80n }),
  ] });
  const listed = await history.read(undefined, "LISTED");
  assert.equal(listed.events.length, 1);
  assert.equal(listed.events[0].type, "UPDATED");
  assert.equal(listed.events[0].price, "120");
  const offers = await history.read(undefined, "OFFERS");
  assert.equal(offers.events[0].type, "OFFER_REFUNDED");
  assert.equal(offers.events[0].actor, BUYER);
  assert.equal(offers.events[0].price, "80");
  const cancelled = await history.read(undefined, "CANCELLED");
  assert.equal(cancelled.events[0].collection, NFT);
});

test("sparse history reads at most four bounded windows and returns a resumable cursor", async () => {
  const history = reader({ latest: 20000n });
  const page = await history.read(undefined, "ALL", 24, 1n);
  // Four 2,000-block windows, each read as four parallel 500-block slices for market and mint logs.
  assert.equal(history.windows.length, 32);
  assert.ok(history.windows.every((window) => window.toBlock - window.fromBlock <= 499n));
  const covered = new Set(history.windows.flatMap((window) => Array.from({ length: Number(window.toBlock - window.fromBlock + 1n) }, (_, index) => window.fromBlock + BigInt(index))));
  assert.equal(covered.size, 8000);
  assert.ok(covered.has(20000n) && covered.has(12001n) && !covered.has(12000n));
  assert.equal(page.nextCursor, "12000:2147483647");
  assert.equal(page.events.length, 0);
  const overflow = reader({ logs: Array.from({ length: 4001 }, (_, index) => log("Listed", index, { collection: NFT, tokenId: 3n, seller: SELLER, price: 100n })) });
  await assert.rejects(overflow.read(), /safe log limit/);
});

test("wallet NUSD mapping pins identity and both collection generations with bounded batches", async () => {
  const tokens = Array.from({ length: 45 }, (_, index) => ({ collection: index % 2 ? OTHER_NFT : NFT, tokenId: String(index) }));
  const batches: number[] = [];
  const client = {
    getChainId: async () => 4441,
    getBlock: async () => ({ number: 900n }),
    readContract: async ({ functionName, blockNumber }: { functionName: string; blockNumber: bigint }) => {
      assert.equal(blockNumber, 900n);
      return functionName === "nusd" ? NUSD : marketplace.NUSD_MARKET_IMPLEMENTATION;
    },
    multicall: async ({ contracts, blockNumber, allowFailure }: { contracts: { functionName: string; args: readonly unknown[] }[]; blockNumber: bigint; allowFailure: boolean }) => {
      assert.equal(blockNumber, 900n);
      assert.equal(allowFailure, false);
      batches.push(contracts.length);
      return contracts.map((call) => {
        if (call.functionName === "tokenToListingId") return BigInt(call.args[1] as bigint) + 1n;
        const tokenId = (call.args[0] as bigint) - 1n;
        return [tokenId % 2n ? OTHER_NFT : NFT, tokenId, 1000000000000000001n, tokenId === 1n ? BUYER : SELLER, tokenId !== 2n];
      });
    },
  } as unknown as Parameters<typeof readNusdWalletListings>[0];
  const listings = await inventoryModule.readNusdWalletListings(client, MARKET, NUSD, tokens, SELLER);
  assert.equal(listings[`${NFT}:0`].price, "1000000000000000001");
  assert.equal(listings[`${OTHER_NFT}:1`], undefined);
  assert.equal(listings[`${NFT}:2`], undefined);
  assert.equal(Object.keys(listings).length, 43);
  assert.deepEqual(batches, [20, 20, 20, 20, 5, 5]);
});

test("wrong NUSD inventory identity never reaches a multicall and empty wallets do not read RPC", async () => {
  let batches = 0, reads = 0;
  const client = {
    getChainId: async () => 4441,
    getBlock: async () => ({ number: 900n }),
    readContract: async ({ functionName }: { functionName: string }) => { reads += 1; return functionName === "nusd" ? OTHER_NFT : marketplace.NUSD_MARKET_IMPLEMENTATION; },
    multicall: async () => { batches += 1; return []; },
  } as unknown as Parameters<typeof readNusdWalletListings>[0];
  await inventoryModule.readNusdWalletListings(client, MARKET, NUSD, [], SELLER);
  assert.equal(reads, 0);
  await assert.rejects(inventoryModule.readNusdWalletListings(client, MARKET, NUSD, [{ collection: NFT, tokenId: "3" }], SELLER), /identity/);
  assert.equal(batches, 0);
});

test("NUSD history filters by event type before identity reads and resolves timestamps once per block", async () => {
  const cancellations = Array.from({ length: 30 }, (_, index) => log("ListingCancelled", 40 + index, { listingId: BigInt(index + 1) }));
  const sale = log("SaleSettled", 9, { collection: NFT, tokenId: 3n, seller: SELLER, buyer: BUYER, price: 100n });
  const history = reader({ logs: [...cancellations, sale], latest: 10001n });
  const sold = await history.read(undefined, "BOUGHT");
  assert.deepEqual(Array.from(sold.events, (event) => event.type), ["BOUGHT"]);
  assert.deepEqual(history.calls.map((call) => call.functionName).sort(), ["IMPLEMENTATION_ID", "nusd"]);
  const cancelled = await history.read(undefined, "CANCELLED", 5);
  assert.equal(cancelled.events.length, 5);
  assert.equal(history.calls.filter((call) => call.functionName === "listings").length, 5);
  assert.equal(cancelled.nextCursor, "10000:65");
  assert.ok(cancelled.events.every((event) => event.timestamp === "1700000000"));
});
