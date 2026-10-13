import assert from "node:assert/strict";
import test from "node:test";
import type { readLegacyListings } from "../../lib/legacyListings.ts";
import { evaluateModule } from "../helpers/evaluateModule.ts";

const MARKET = "0x0000000000000000000000000000000000000011" as const;
const NFT = "0x0000000000000000000000000000000000000033" as const;
const OTHER_NFT = "0x0000000000000000000000000000000000000044" as const;
const SELLER = "0x0000000000000000000000000000000000000055" as const;
const STRANGER = "0x0000000000000000000000000000000000000066" as const;
const { readLegacyListings: read } = evaluateModule<{ readLegacyListings: typeof readLegacyListings }>(
  new URL("../../lib/legacyListings.ts", import.meta.url), { "./marketplaceAbi": { MarketplaceAbi: [] } }, { Error },
);

type Listing = { collection: string; tokenId: bigint; price: bigint; seller: string; active: boolean };
function client(listings: Record<string, [bigint, Listing]>) {
  const batches: number[] = [];
  return {
    batches,
    multicall: async ({ contracts }: { contracts: { address: string; functionName: string; args: readonly [string, bigint] }[] }) => {
      batches.push(contracts.length);
      assert.ok(contracts.every((call) => call.address === MARKET && call.functionName === "getListingByToken"));
      return contracts.map(({ args: [collection, tokenId] }) => listings[`${collection}:${tokenId}`] ?? [0n, { collection: "0x0000000000000000000000000000000000000000", tokenId: 0n, price: 0n, seller: "0x0000000000000000000000000000000000000000", active: false }]);
    },
  };
}

test("legacy listings report only the wallet's own active listings for NFTs it still holds", async () => {
  const rpc = client({
    [`${NFT}:1`]: [7n, { collection: NFT, tokenId: 1n, price: 4n * 10n ** 18n, seller: SELLER, active: true }],
    [`${NFT}:2`]: [8n, { collection: NFT, tokenId: 2n, price: 1n, seller: STRANGER, active: true }],
    [`${NFT}:3`]: [9n, { collection: NFT, tokenId: 3n, price: 1n, seller: SELLER, active: false }],
    [`${OTHER_NFT}:4`]: [10n, { collection: NFT, tokenId: 4n, price: 1n, seller: SELLER, active: true }],
  });
  const tokens: { collection: `0x${string}`; tokenId: bigint }[] = [...[1n, 2n, 3n, 5n].map((tokenId) => ({ collection: NFT, tokenId })), { collection: OTHER_NFT, tokenId: 4n }];
  const found = await read(rpc as never, MARKET, SELLER.toUpperCase().replace("0X", "0x") as `0x${string}`, tokens);
  assert.deepEqual(JSON.parse(JSON.stringify(found, (_, value) => typeof value === "bigint" ? value.toString() : value)), [{ listingId: "7", collection: NFT, tokenId: "1", price: (4n * 10n ** 18n).toString() }]);
});

test("legacy listing reads are batched and skip RPC for empty wallets", async () => {
  const rpc = client({});
  assert.equal((await read(rpc as never, MARKET, SELLER, [])).length, 0);
  assert.equal(rpc.batches.length, 0);
  await read(rpc as never, MARKET, SELLER, Array.from({ length: 250 }, (_, index) => ({ collection: NFT, tokenId: BigInt(index) })));
  assert.deepEqual(rpc.batches, [100, 100, 50]);
});
