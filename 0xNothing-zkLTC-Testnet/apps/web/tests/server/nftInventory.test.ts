import assert from "node:assert/strict";
import test from "node:test";
import { createBoundedCache } from "../../lib/boundedCache.ts";
import { getPixelImageUrl } from "../../lib/pixelImage.ts";
import { evaluateModule } from "../helpers/evaluateModule.ts";

const legacy = `0x${"1".repeat(40)}` as const;
const v2 = `0x${"2".repeat(40)}` as const;
const owner = `0x${"3".repeat(40)}` as const;
const marketplace = `0x${"4".repeat(40)}` as const;
const quiet = { warn() {}, error() {} };

test("post-transaction enumeration bypasses a cached inventory and never masks refresh failure with old IDs", async () => {
  let ids = [1n];
  let failed = false;
  let reads = 0;
  const client = {
    readContract: async () => {
      reads++;
      if (failed) throw new Error("RPC unavailable");
      return BigInt(ids.length);
    },
    multicall: async () => ids.map((id) => ({ status: "success", result: id })),
  };
  const contract = evaluateModule<{ getUserTokenIds: (owner: string, collection: `0x${string}`, force?: boolean) => Promise<bigint[]> }>(
    new URL("../../lib/contract.ts", import.meta.url),
    {
      viem: { createPublicClient: () => client, http: () => ({}) },
      "./abi": { PixelNFTABI: [] },
      "@/config/wagmi": { litvm: {}, LITVM_RPC_URL: "https://rpc.invalid" },
      "@/lib/boundedCache": { createBoundedCache },
      "@/lib/publicConfig": { PIXEL_NFT_ADDRESS: legacy, PIXEL_MARKETPLACE_ADDRESS: marketplace },
      "./explorer": { getTransactionExplorerUrl: () => "" },
    },
    { console: quiet, setTimeout },
  );
  const read = (force = false) => contract.getUserTokenIds(owner, legacy, force);
  assert.deepEqual(Array.from(await read()), [1n]);
  ids = [2n, 3n];
  assert.deepEqual(Array.from(await read()), [1n], "ordinary reads retain the fast cache");
  assert.equal(reads, 1);
  assert.deepEqual(Array.from(await read(true)), [2n, 3n], "forced reads discover new ownership immediately");
  assert.deepEqual(Array.from(await read()), [2n, 3n], "a successful refresh updates subsequent reads");
  failed = true;
  await assert.rejects(read(true), /RPC unavailable/);
  assert.deepEqual(Array.from(await read()), [2n, 3n], "failed refreshes preserve the last successful inventory");
  ids = [];
  failed = false;
  assert.deepEqual(Array.from(await read(true)), [], "transferring the last NFT also refreshes a non-empty cache");
});

test("an older wallet enumeration cannot overwrite a completed forced refresh", async () => {
  for (const freshIds of [[2n, 3n], []] as bigint[][]) {
    let balanceReads = 0;
    let enumerationCalls = 0;
    let releaseOld!: (results: Array<{ status: "success"; result: bigint }>) => void;
    let oldStarted!: () => void;
    const started = new Promise<void>((resolve) => { oldStarted = resolve; });
    const delayedOld = new Promise<Array<{ status: "success"; result: bigint }>>((resolve) => { releaseOld = resolve; });
    const client = {
      readContract: async () => BigInt(++balanceReads === 1 ? 1 : freshIds.length),
      multicall: async () => {
        if (++enumerationCalls === 1) {
          oldStarted();
          return delayedOld;
        }
        return freshIds.map((id) => ({ status: "success" as const, result: id }));
      },
    };
    const contract = evaluateModule<{ getUserTokenIds: (owner: string, collection: `0x${string}`, force?: boolean) => Promise<bigint[]> }>(
      new URL("../../lib/contract.ts", import.meta.url),
      {
        viem: { createPublicClient: () => client, http: () => ({}) },
        "./abi": { PixelNFTABI: [] },
        "@/config/wagmi": { litvm: {}, LITVM_RPC_URL: "https://rpc.invalid" },
        "@/lib/boundedCache": { createBoundedCache },
        "@/lib/publicConfig": { PIXEL_NFT_ADDRESS: legacy, PIXEL_MARKETPLACE_ADDRESS: marketplace },
        "./explorer": { getTransactionExplorerUrl: () => "" },
      },
      { console: quiet, setTimeout },
    );
    const oldRead = contract.getUserTokenIds(owner, legacy);
    await started;
    assert.deepEqual(Array.from(await contract.getUserTokenIds(owner, legacy, true)), freshIds);
    releaseOld([{ status: "success", result: 1n }]);
    assert.deepEqual(Array.from(await oldRead), [1n], "the original caller can finish its own snapshot");
    assert.deepEqual(Array.from(await contract.getUserTokenIds(owner, legacy)), freshIds,
      "subsequent reads retain the newer ownership even when the old RPC completes last");
    assert.equal(balanceReads, 2, "the completed fresh result remains cached");
  }
});

test("large V2 wallet reads packed art in bounded ordered batches and forwards force to enumeration", async () => {
  const ids = Array.from({ length: 45 }, (_, i) => BigInt(i + 1));
  const widths: number[] = [];
  const freshness: boolean[] = [];
  let active = 0;
  let peak = 0;
  const route = evaluateModule<{ GET: (request: Request) => Promise<Response> }>(
    new URL("../../app/api/user-nfts/route.ts", import.meta.url),
    {
      "next/server": { NextResponse: Response },
      "@/lib/contract": {
        PIXEL_NFT_CONTRACT_ADDRESS: legacy,
        PIXEL_MARKETPLACE_ADDRESS: marketplace,
        getUserTokenIds: async (_owner: string, collection: string, force: boolean) => {
          assert.equal(collection, v2);
          freshness.push(force);
          return ids;
        },
        publicClient: {
          multicall: async ({ contracts }: { contracts: Array<{ functionName: string; args: bigint[] }> }) => {
            widths.push(contracts.length);
            active++;
            peak = Math.max(peak, active);
            await Promise.resolve();
            active--;
            return contracts.map(({ functionName, args }) => {
              if (functionName === "getListingByToken") return { status: "success", result: [args[1], { active: true, price: args[1] * 10n }] };
              assert.equal(functionName, "tokenPackedData", "V2 never runs legacy hex conversion");
              return { status: "success", result: [`Art ${args[0]}`, "Description", 256n, "0xaabbcc", owner, 2n, "hash"] };
            });
          },
        },
      },
      "@/lib/pixelImage": { getPixelImageUrl },
      "@/lib/marketplaceAbi": { MarketplaceAbi: [] },
      "@/lib/abi": { PixelNFTABI: [] },
      "@/lib/pixelV2Abi": { PixelV2ABI: [] },
      "@/lib/marketplaceSubgraph": { hasMarketplaceSubgraph: () => false },
      "@/lib/boundedCache": { createBoundedCache },
      "@/lib/server/publicError": { publicErrorMessage: () => "unavailable" },
      "@/lib/pixelCollections": { PIXEL_COLLECTIONS: [{ address: v2 }], isPixelV2Collection: () => true },
    },
    { URL, console: quiet },
  );
  const response = await route.GET(new Request(`https://app.test/api/user-nfts?address=${owner}&force=1`));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.count, 45);
  assert.deepEqual(body.tokens.map((nft: { tokenId: string }) => nft.tokenId), ids.map(String));
  assert.equal(body.tokens[44].name, "Art 45");
  assert.equal(body.tokens[44].imageUrl, getPixelImageUrl(45, v2));
  assert.deepEqual(body.tokens[44].listing, { listingId: "45", price: "450" });
  assert.deepEqual(widths, [20, 20, 20, 20, 5, 5]);
  assert.equal(peak, 2, "batch progression waits for both data and listing reads");
  assert.deepEqual(freshness, [true]);
  assert.match(response.headers.get("cache-control") ?? "", /no-store/);
});
