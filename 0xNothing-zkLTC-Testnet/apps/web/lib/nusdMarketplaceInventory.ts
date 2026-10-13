import type { Address, PublicClient } from "viem";
import { NUSD_MARKET_IMPLEMENTATION, NusdMarketplaceAbi } from "./nusdMarketplace";

type WalletListing = { listingId: string; price: string };

export async function readNusdWalletListings(
  client: Pick<PublicClient, "getChainId" | "getBlock" | "readContract" | "multicall">,
  market: Address,
  nusd: Address,
  tokens: readonly { collection: Address; tokenId: string }[],
  account: Address,
): Promise<Record<string, WalletListing>> {
  const listings: Record<string, WalletListing> = {};
  if (!tokens.length) return listings;
  const [chainId, block] = await Promise.all([client.getChainId(), client.getBlock({ blockTag: "latest" })]);
  if (chainId !== 4441 || block.number === null) throw new Error("Invalid NUSD inventory chain or block");
  const contract = { address: market, abi: NusdMarketplaceAbi, blockNumber: block.number };
  const [token, implementation] = await Promise.all([
    client.readContract({ ...contract, functionName: "nusd" }),
    client.readContract({ ...contract, functionName: "IMPLEMENTATION_ID" }),
  ]);
  if (token.toLowerCase() !== nusd.toLowerCase() || implementation.toLowerCase() !== NUSD_MARKET_IMPLEMENTATION.toLowerCase()) throw new Error("Invalid NUSD inventory marketplace identity");
  for (let offset = 0; offset < tokens.length; offset += 20) {
    const batch = tokens.slice(offset, offset + 20);
    const ids = await client.multicall({
      blockNumber: block.number, allowFailure: false,
      contracts: batch.map((item) => ({ address: market, abi: NusdMarketplaceAbi, functionName: "tokenToListingId" as const, args: [item.collection, BigInt(item.tokenId)] as const })),
    });
    if (ids.length !== batch.length) throw new Error("Incomplete NUSD inventory mapping");
    const active = batch.flatMap((item, index) => ids[index] > 0n ? [{ ...item, id: ids[index] }] : []);
    if (!active.length) continue;
    const rows = await client.multicall({
      blockNumber: block.number, allowFailure: false,
      contracts: active.map((item) => ({ address: market, abi: NusdMarketplaceAbi, functionName: "listings" as const, args: [item.id] as const })),
    });
    if (rows.length !== active.length) throw new Error("Incomplete NUSD inventory listings");
    for (let index = 0; index < active.length; index++) {
      const item = active[index];
      const [collection, tokenId, price, seller, enabled] = rows[index];
      if (enabled && collection.toLowerCase() === item.collection.toLowerCase() && tokenId === BigInt(item.tokenId) && seller.toLowerCase() === account.toLowerCase()) {
        listings[`${item.collection.toLowerCase()}:${item.tokenId}`] = { listingId: item.id.toString(), price: price.toString() };
      }
    }
  }
  return listings;
}
