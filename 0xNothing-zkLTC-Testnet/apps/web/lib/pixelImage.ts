export function getPixelImageUrl(tokenId: string | number | bigint, collection?: string): string {
  return `/api/pixel-image?tokenId=${tokenId.toString()}${collection ? `&collection=${collection.toLowerCase()}` : ""}`;
}
