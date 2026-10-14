/** Collection-aware NFT identity: both 0xPixel collections start at token #1. */
export function marketplaceNftKey(
  collection: string,
  tokenId: string | bigint,
): string {
  return `${collection.toLowerCase()}:${tokenId.toString()}`;
}
