import type { Address } from "viem";
import { PIXEL_CLASSIC_ADDRESS, PIXEL_CLASSIC_START_BLOCK, PIXEL_NFT_ADDRESS, PIXEL_START_BLOCK } from "./publicConfig";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
export const PIXEL_MINT_ENABLED = PIXEL_NFT_ADDRESS.toLowerCase() !== ZERO_ADDRESS;
export const PIXEL_MINT_ADDRESS = PIXEL_NFT_ADDRESS;
export const PIXEL_COLLECTIONS = [
  { address: PIXEL_CLASSIC_ADDRESS, startBlock: PIXEL_CLASSIC_START_BLOCK, name: "0xPixel Classic" },
  ...(PIXEL_MINT_ENABLED ? [{ address: PIXEL_NFT_ADDRESS, startBlock: PIXEL_START_BLOCK, name: "0xPixel" }] : []),
] as const;

/** Omitted collections always refer to Classic, including permanently cached image URLs. */
export function resolvePixelCollection(value?: string | null): Address | null {
  if (!value) return PIXEL_CLASSIC_ADDRESS;
  return PIXEL_COLLECTIONS.find((entry) => entry.address.toLowerCase() === value.toLowerCase())?.address ?? null;
}

export function isPixelCollection(value: string): boolean {
  return PIXEL_COLLECTIONS.some((entry) => entry.address.toLowerCase() === value.toLowerCase());
}

export function isPackedPixelCollection(value: string): boolean {
  return PIXEL_MINT_ENABLED && value.toLowerCase() === PIXEL_NFT_ADDRESS.toLowerCase();
}

export function pixelTokenKey(collection: string, tokenId: string | bigint | number): string {
  return `${collection.toLowerCase()}:${tokenId.toString()}`;
}

export function pixelUtf8Bytes(value: string): number {
  return new TextEncoder().encode(value).length;
}
