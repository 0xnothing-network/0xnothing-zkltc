import type { Address, Hex } from "viem";
import { pixelNftAbi } from "../../abis";
import { PIXEL_COLLECTIONS } from "../../config/contracts";
import { pixelDataToSvgDataUrl } from "../lib/pixelSvg";
import { activeNetwork, publicClient } from "../rpc/client";
import { writeCall } from "./tx";

/**
 * The NFT tab. Both 0xPixel collections keep their artwork
 * lives entirely on chain: `tokenData` returns the pixel string, so the wallet
 * renders the image itself instead of asking an IPFS gateway or a metadata API
 * for anything. No network beyond the RPC node is involved in showing an NFT.
 *
 * `userTokens(owner, index)` walks the owner's list, so the read is two waves:
 * one for the ids, one for the data behind them.
 */
export interface PixelNft {
  collection: Address;
  collectionName: string;
  tokenId: bigint;
  name: string;
  gridSize: number;
  creator: Address;
  mintedAt: number;
  /** Inline SVG data URL built from the on-chain pixels; "" when unrenderable. */
  image: string;
}

/** Cap each collection independently so legacy artwork remains accessible. */
const MAX_LISTED = 60;

type TokenData = readonly [string, bigint, string, Address, bigint, Hex];

export async function loadPixelNfts(owner: Address): Promise<PixelNft[]> {
  if (!activeNetwork.builtin) return [];
  const readClient = publicClient;
  const inventories = await Promise.all(PIXEL_COLLECTIONS.map(async (collection) => {
    const nft = { address: collection.address, abi: pixelNftAbi } as const;
    const balance = await readClient.readContract({ ...nft, functionName: "balanceOf", args: [owner] });
    const count = Number(balance > BigInt(MAX_LISTED) ? BigInt(MAX_LISTED) : balance);
    if (count <= 0) return [];
    const start = balance - BigInt(count);

    const ids = await readClient.multicall({
      allowFailure: true,
      contracts: Array.from({ length: count }, (_, index) => ({
        ...nft,
        functionName: "userTokens" as const,
        args: [owner, start + BigInt(index)] as const,
      })),
    });
    // A failed read is not an empty/partial inventory: let useLiveRead retain
    // the last successful snapshot until the RPC can return a complete one.
    const tokenIds = ids.map((entry) => {
      if (entry.status === "failure") throw entry.error;
      return entry.result as bigint;
    });
    if (tokenIds.length === 0) return [];

    const data = await readClient.multicall({
      allowFailure: true,
      contracts: tokenIds.map((tokenId) => ({
        ...nft,
        functionName: "tokenData" as const,
        args: [tokenId] as const,
      })),
    });

    const rows: PixelNft[] = [];
    tokenIds.forEach((tokenId, index) => {
      const entry = data[index];
      if (entry?.status === "failure") throw entry.error;
      if (entry?.status !== "success") return;
      const [name, gridSize, pixelData, creator, mintedAt] = entry.result as TokenData;
      const size = Number(gridSize);
      if (!Number.isInteger(size) || size <= 0 || size > 256) return;
      const cleanName = typeof name === "string"
        && name.trim().length > 0
        && name.trim().length <= 80
        && !/[\u0000-\u001f\u007f]/u.test(name)
        ? name.trim()
        : `#${tokenId}`;
      rows.push({
        collection: collection.address,
        collectionName: collection.name,
        tokenId,
        name: cleanName,
        gridSize: size,
        creator,
        mintedAt: Number(mintedAt) * 1000,
        image: pixelDataToSvgDataUrl(pixelData, size),
      });
    });
    return rows;
  }));
  return inventories.flat().sort((left, right) => right.mintedAt - left.mintedAt
    || (left.tokenId === right.tokenId ? 0 : left.tokenId > right.tokenId ? -1 : 1));
}

export function pixelNftKey(collection: string, tokenId: string | bigint): string {
  return `${collection.toLowerCase()}:${tokenId.toString()}`;
}

export function findPixelNft(rows: readonly PixelNft[], collection: string, tokenId: string): PixelNft | null {
  const key = pixelNftKey(collection, tokenId);
  return rows.find((nft) => pixelNftKey(nft.collection, nft.tokenId) === key) ?? null;
}

export async function transferPixelNft(params: {
  from: Address;
  to: Address;
  tokenId: bigint;
  name: string;
  collection: Address;
}): Promise<Hex> {
  const collection = PIXEL_COLLECTIONS.find((entry) => entry.address.toLowerCase() === params.collection.toLowerCase());
  if (!collection) throw new Error("Unknown 0xPixel collection");
  return writeCall({
    from: params.from,
    address: collection.address,
    abi: pixelNftAbi,
    functionName: "transferNFT",
    args: [params.to, params.tokenId],
    kind: "nft",
    label: { key: "tx.nft", params: { name: params.name } },
    detail: params.to,
  });
}
