import { parseAbi, zeroAddress, type Address, type PublicClient } from "viem";

/**
 * The retired zkLTC PixelMarket (0x1333…86F4, source in contracts/src/0xpixel/reference/0xMarketplace.deployed.sol).
 * It pays sellers directly at settlement (no credits), so the only user-held state left there is
 * active listings (still buyable in zkLTC while the NFT approval is live) and escrowed zkLTC offers.
 */
export const LegacyPixelMarketAbi = parseAbi([
  "function paused() view returns (bool)",
  "function getActiveListings(uint256 offset, uint256 limit) view returns (uint256[])",
  "function listings(uint256 id) view returns (address collection, uint256 tokenId, uint256 price, address seller, bool active)",
  "function offers(uint256 id) view returns (address collection, uint256 tokenId, address offerer, uint256 price, bool active)",
  "function cancelListing(uint256 listingId)",
  "function cancelOffer(uint256 offerId)",
]);

export const LEGACY_LISTING_PAGE = 200n;
export const LEGACY_OFFER_BATCH = 50n;
export const LEGACY_SCAN_CAP = 5_000n;

export type LegacyListing = { id: bigint; collection: Address; tokenId: bigint; price: bigint };
export type LegacyOffer = { id: bigint; collection: Address; tokenId: bigint; price: bigint };
type Reader = Pick<PublicClient, "getChainId" | "getBlockNumber" | "readContract" | "multicall">;

/** Active listings and escrowed offers owned by `account` on the legacy market, read at one block. */
export async function readLegacyPositions(client: Reader, market: Address, account: Address) {
  if (await client.getChainId() !== 4441) throw new Error("Switch to LiteForge (4441) to read the legacy marketplace");
  const blockNumber = await client.getBlockNumber();
  const contract = { address: market, abi: LegacyPixelMarketAbi, blockNumber } as const;
  const me = account.toLowerCase();
  const paused = await client.readContract({ ...contract, functionName: "paused" });

  const activeIds: bigint[] = [];
  for (let offset = 0n; offset < LEGACY_SCAN_CAP;) {
    const page = await client.readContract({ ...contract, functionName: "getActiveListings", args: [offset, LEGACY_LISTING_PAGE] });
    activeIds.push(...page);
    if (BigInt(page.length) < LEGACY_LISTING_PAGE) break;
    offset = page[page.length - 1];
  }
  const listings: LegacyListing[] = [];
  for (let index = 0; index < activeIds.length; index += 50) {
    const ids = activeIds.slice(index, index + 50);
    const rows = await client.multicall({ blockNumber, allowFailure: false, contracts: ids.map((id) => ({ address: market, abi: LegacyPixelMarketAbi, functionName: "listings" as const, args: [id] as const })) });
    rows.forEach(([collection, tokenId, price, seller, active], i) => {
      if (active && seller.toLowerCase() === me) listings.push({ id: ids[i], collection, tokenId, price });
    });
  }

  // Offer ids are sequential from 1; an empty offerer marks the end of the issued range.
  const offers: LegacyOffer[] = [];
  let complete = false;
  for (let start = 1n; start <= LEGACY_SCAN_CAP && !complete; start += LEGACY_OFFER_BATCH) {
    const ids = Array.from({ length: Number(LEGACY_OFFER_BATCH) }, (_, i) => start + BigInt(i));
    const rows = await client.multicall({ blockNumber, allowFailure: false, contracts: ids.map((id) => ({ address: market, abi: LegacyPixelMarketAbi, functionName: "offers" as const, args: [id] as const })) });
    for (let i = 0; i < rows.length; i++) {
      const [collection, tokenId, offerer, price, active] = rows[i];
      if (offerer === zeroAddress) { complete = true; break; }
      if (active && offerer.toLowerCase() === me) offers.push({ id: ids[i], collection, tokenId, price });
    }
  }
  return { blockNumber, paused, listings, offers, scannedListings: activeIds.length, offerScanComplete: complete };
}
