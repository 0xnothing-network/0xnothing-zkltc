export function getPixelImageUrl(tokenId: string | number | bigint): string {
  return `/api/pixel-image?tokenId=${tokenId.toString()}`;
}
