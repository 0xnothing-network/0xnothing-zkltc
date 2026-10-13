import type { Address, PublicClient } from "viem";
import { MarketplaceAbi } from "./marketplaceAbi";

export type LegacyListing = { listingId: bigint; collection: Address; tokenId: bigint; price: bigint };

/**
 * Finds the wallet's still-active listings on the retired native-zkLTC
 * marketplace. Only NFTs the wallet still owns are checked: those are exactly
 * the listings a third party can still buy at the old zkLTC price, because the
 * old contract settles from the seller's wallet while its approval remains.
 */
export async function readLegacyListings(
  client: Pick<PublicClient, "multicall">,
  market: Address,
  seller: Address,
  tokens: readonly { collection: Address; tokenId: bigint }[],
): Promise<LegacyListing[]> {
  const found: LegacyListing[] = [];
  for (let offset = 0; offset < tokens.length; offset += 100) {
    const batch = tokens.slice(offset, offset + 100);
    const results = await client.multicall({
      allowFailure: false,
      contracts: batch.map((token) => ({ address: market, abi: MarketplaceAbi, functionName: "getListingByToken" as const, args: [token.collection, token.tokenId] as const })),
    });
    if (results.length !== batch.length) throw new Error("Incomplete legacy listing read");
    results.forEach(([listingId, listing], index) => {
      const token = batch[index];
      if (listingId === 0n || !listing.active || listing.seller.toLowerCase() !== seller.toLowerCase()) return;
      if (listing.collection.toLowerCase() !== token.collection.toLowerCase() || listing.tokenId !== token.tokenId) return;
      found.push({ listingId, collection: token.collection, tokenId: token.tokenId, price: listing.price });
    });
  }
  return found;
}
