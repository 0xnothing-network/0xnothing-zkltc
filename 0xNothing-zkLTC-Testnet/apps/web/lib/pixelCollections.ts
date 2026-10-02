import type { Address } from "viem";
import { PIXEL_NFT_ADDRESS, PIXEL_START_BLOCK, PIXEL_V2_NFT_ADDRESS, PIXEL_V2_START_BLOCK } from "./publicConfig";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
export const PIXEL_V2_ENABLED = PIXEL_V2_NFT_ADDRESS.toLowerCase() !== ZERO_ADDRESS;
export const PIXEL_MINT_ADDRESS = PIXEL_V2_NFT_ADDRESS;
export const PIXEL_COLLECTIONS = [
  { address: PIXEL_NFT_ADDRESS, startBlock: PIXEL_START_BLOCK, version: 1 },
  ...(PIXEL_V2_ENABLED ? [{ address: PIXEL_V2_NFT_ADDRESS, startBlock: PIXEL_V2_START_BLOCK, version: 2 }] : []),
] as const;

/** Omitted collections always refer to V1, including permanently cached image URLs. */
export function resolvePixelCollection(value?: string | null): Address | null {
  if (!value) return PIXEL_NFT_ADDRESS;
  return PIXEL_COLLECTIONS.find((entry) => entry.address.toLowerCase() === value.toLowerCase())?.address ?? null;
}

export function isPixelCollection(value: string): boolean {
  return PIXEL_COLLECTIONS.some((entry) => entry.address.toLowerCase() === value.toLowerCase());
}

export function isPixelV2Collection(value: string): boolean {
  return PIXEL_V2_ENABLED && value.toLowerCase() === PIXEL_V2_NFT_ADDRESS.toLowerCase();
}

export function pixelTokenKey(collection: string, tokenId: string | bigint | number): string {
  return `${collection.toLowerCase()}:${tokenId.toString()}`;
}

export function pixelUtf8Bytes(value: string): number {
  return new TextEncoder().encode(value).length;
}
