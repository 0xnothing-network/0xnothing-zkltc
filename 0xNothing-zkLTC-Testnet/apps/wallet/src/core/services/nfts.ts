import type { Address, Hex } from "viem";
import { pixelNftAbi } from "../../abis";
import { CONTRACTS } from "../../config/contracts";
import { pixelDataToSvgDataUrl } from "../lib/pixelSvg";
import { activeNetwork, publicClient } from "../rpc/client";
import { writeCall } from "./tx";

/**
 * The NFT tab. 0xPixel is the only collection this chain has, and its artwork
 * lives entirely on chain: `tokenData` returns the pixel string, so the wallet
 * renders the image itself instead of asking an IPFS gateway or a metadata API
 * for anything. No network beyond the RPC node is involved in showing an NFT.
 *
 * `userTokens(owner, index)` walks the owner's list, so the read is two waves:
 * one for the ids, one for the data behind them.
 */
export interface PixelNft {
  tokenId: bigint;
  name: string;
  gridSize: number;
  creator: Address;
  mintedAt: number;
  /** Inline SVG data URL built from the on-chain pixels; "" when unrenderable. */
  image: string;
}

/** A popup list is scrolled, not paged; this is the cap the grid renders. */
const MAX_LISTED = 60;

type TokenData = readonly [string, bigint, string, Address, bigint, Hex];

export async function loadPixelNfts(owner: Address): Promise<PixelNft[]> {
  if (!activeNetwork.builtin) return [];
  const nft = { address: CONTRACTS.pixelNft, abi: pixelNftAbi } as const;
  const balance = await publicClient
    .readContract({ ...nft, functionName: "balanceOf", args: [owner] })
    .catch(() => 0n);
  const count = Number(balance > BigInt(MAX_LISTED) ? BigInt(MAX_LISTED) : balance);
  if (count <= 0) return [];
  const start = balance - BigInt(count);

  const ids = await publicClient.multicall({
    allowFailure: true,
    contracts: Array.from({ length: count }, (_, index) => ({
      ...nft,
      functionName: "userTokens" as const,
      args: [owner, start + BigInt(index)] as const,
    })),
  });
  const tokenIds = ids
    .map((entry) => (entry.status === "success" ? (entry.result as bigint) : null))
    .filter((id): id is bigint => id !== null);
  if (tokenIds.length === 0) return [];

  const data = await publicClient.multicall({
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
      tokenId,
      name: cleanName,
      gridSize: size,
      creator,
      mintedAt: Number(mintedAt) * 1000,
      image: pixelDataToSvgDataUrl(pixelData, size),
    });
  });
  // Newest first: the list the contract keeps is append-ordered.
  return rows.reverse();
}

export async function transferPixelNft(params: {
  from: Address;
  to: Address;
  tokenId: bigint;
  name: string;
}): Promise<Hex> {
  return writeCall({
    from: params.from,
    address: CONTRACTS.pixelNft,
    abi: pixelNftAbi,
    functionName: "transferNFT",
    args: [params.to, params.tokenId],
    kind: "nft",
    label: { key: "tx.nft", params: { name: params.name } },
    detail: params.to,
  });
}
