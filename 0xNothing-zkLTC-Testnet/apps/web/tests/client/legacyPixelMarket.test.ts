import assert from "node:assert/strict";
import test from "node:test";
import { getAddress, zeroAddress, type Address } from "viem";
import { LEGACY_LISTING_PAGE, readLegacyPositions } from "../../lib/legacyPixelMarket.ts";

const MARKET = getAddress("0x0000000000000000000000000000000000000011");
const NFT = getAddress("0x0000000000000000000000000000000000000033");
const ME = getAddress("0x0000000000000000000000000000000000000044");
const OTHER = getAddress("0x0000000000000000000000000000000000000055");

function fakeClient(options: { chainId?: number; activeIds: bigint[]; sellers: Record<string, Address>; offers: { offerer: Address; active: boolean }[] }) {
  const pages: bigint[] = [];
  const client = {
    getChainId: async () => options.chainId ?? 4441,
    getBlockNumber: async () => 100n,
    readContract: async ({ functionName, args }: { functionName: string; args?: readonly bigint[] }) => {
      if (functionName === "paused") return false;
      if (functionName === "getActiveListings") {
        const [offset, limit] = args!; pages.push(offset);
        return options.activeIds.filter((id) => id > offset).slice(0, Number(limit));
      }
      throw new Error(`Unexpected read ${functionName}`);
    },
    multicall: async ({ contracts }: { contracts: { functionName: string; args: readonly [bigint] }[] }) => contracts.map(({ functionName, args: [id] }) => {
      if (functionName === "listings") return [NFT, id, 10n ** 18n, options.sellers[id.toString()] ?? OTHER, true];
      const offer = options.offers[Number(id) - 1];
      return offer ? [NFT, id, offer.offerer, 5n, offer.active] : [zeroAddress, 0n, zeroAddress, 0n, false];
    }),
  };
  return { client: client as never, pages };
}

test("legacy reader pages through every active listing and keeps only the wallet's own", async () => {
  const activeIds = Array.from({ length: Number(LEGACY_LISTING_PAGE) + 5 }, (_, i) => BigInt(i * 2 + 1));
  const { client, pages } = fakeClient({ activeIds, sellers: { "1": ME, [activeIds.at(-1)!.toString()]: ME }, offers: [] });
  const result = await readLegacyPositions(client, MARKET, ME);
  assert.deepEqual(pages, [0n, activeIds[Number(LEGACY_LISTING_PAGE) - 1]]);
  assert.equal(result.scannedListings, activeIds.length);
  assert.deepEqual(result.listings.map((listing) => listing.id), [1n, activeIds.at(-1)]);
  assert.equal(result.offerScanComplete, true);
});

test("legacy reader finds active own offers and stops at the first unissued id", async () => {
  const offers = [{ offerer: ME, active: false }, { offerer: OTHER, active: true }, { offerer: ME, active: true }];
  const { client } = fakeClient({ activeIds: [], sellers: {}, offers });
  const result = await readLegacyPositions(client, MARKET, ME.toLowerCase() as Address);
  assert.deepEqual(result.offers.map((offer) => offer.id), [3n]);
  assert.equal(result.offerScanComplete, true);
});

test("legacy reader refuses the wrong chain", async () => {
  const { client } = fakeClient({ chainId: 1, activeIds: [], sellers: {}, offers: [] });
  await assert.rejects(readLegacyPositions(client, MARKET, ME), /4441/);
});
