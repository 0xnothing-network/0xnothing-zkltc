import { createPublicClient, http } from "viem";
import { PixelNFTABI } from "./abi";
import { litvm, LITVM_RPC_URL } from "@/config/wagmi";
import { createBoundedCache } from "@/lib/boundedCache";
import {
  PIXEL_MARKETPLACE_ADDRESS as PUBLIC_PIXEL_MARKETPLACE_ADDRESS,
  PIXEL_NFT_ADDRESS,
} from "@/lib/publicConfig";
import {
  getTokenExplorerUrl,
  getTransactionExplorerUrl,
} from "./explorer";

export {
  LITVM_EXPLORER_URL,
  getAddressExplorerUrl,
  getTokenExplorerUrl,
  getTransactionExplorerUrl,
} from "./explorer";

export const PIXEL_NFT_CONTRACT_ADDRESS = PIXEL_NFT_ADDRESS;

export const PIXEL_MARKETPLACE_ADDRESS = PUBLIC_PIXEL_MARKETPLACE_ADDRESS;

export function getExplorerUrl(tokenId?: bigint | number | string): string {
  return getTokenExplorerUrl(PIXEL_NFT_CONTRACT_ADDRESS, tokenId);
}

export function getMarketplaceTxUrl(txHash: string): string {
  return getTransactionExplorerUrl(txHash);
}

export function shortenAddress(addr: string, head = 6, tail = 4): string {
  if (!addr) return "";
  if (addr.length < head + tail + 2) return addr;
  return `${addr.slice(0, head)}...${addr.slice(-tail)}`;
}

export const publicClient = createPublicClient({
  chain: litvm,
  transport: http(LITVM_RPC_URL, {
    // The browser transport in lib/wagmi.ts already relies on JSON-RPC batching
    // against this endpoint. Server routes fan out far wider (per-block
    // timestamps, per-holder balances), so collapsing those into batched
    // requests removes most of the round-trips from the response path.
    batch: { batchSize: 100, wait: 10 },
    retryCount: 2,
    retryDelay: 300,
    timeout: 15_000,
  }),
  batch: { multicall: { batchSize: 16_384 } },
});

async function withRetry<T>(
  fn: () => Promise<T>,
  attempts = 5,
  baseDelayMs = 500
): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err: unknown) {
      lastErr = err;
      const msg = String((err as { message?: string })?.message || err);
      const isRateLimit =
        msg.includes("Bandwidth limit") ||
        msg.includes("rate limit") ||
        msg.includes("429") ||
        msg.includes("limit exceeded") ||
        msg.includes("too many requests");
      
      // Deterministic RPC errors do not become healthy after an extra delay.
      if (!isRateLimit) throw err;
      if (i < attempts - 1) {
        const delay = baseDelayMs * Math.pow(2, i);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }
  throw lastErr;
}

const CACHE_TTL_SUCCESS = 30_000;
const USER_NFT_CACHE_MAX = 1_024;

// null records a failed enumeration: it blocks the fast path for the ttl without
// ever being served as a token list.
const userNftCache = createBoundedCache<bigint[] | null>({
  maxEntries: USER_NFT_CACHE_MAX,
  ttlMs: CACHE_TTL_SUCCESS,
});

export async function getUserTokenIds(address: string): Promise<bigint[]> {
  if (!address || typeof address !== "string" || !address.match(/^0x[0-9a-fA-F]{40}$/)) {
    return [];
  }
  const addr = address.toLowerCase() as `0x${string}`;

  const cached = userNftCache.get(addr);
  if (cached) return cached;

  try {
    const balance = (await withRetry(() =>
      publicClient.readContract({
        address: PIXEL_NFT_CONTRACT_ADDRESS,
        abi: PixelNFTABI,
        functionName: "balanceOf",
        args: [addr],
      })
    )) as bigint;
    if (balance > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error("NFT balance is too large to enumerate safely");
    }
    const n = Number(balance);

    if (n === 0) {
      userNftCache.set(addr, []);
      return [];
    }

    const BATCH = 100;
    const allIds: bigint[] = [];

    for (let start = 0; start < n; start += BATCH) {
      const indexes = Array.from(
        { length: Math.min(BATCH, n - start) },
        (_, offset) => start + offset
      );
      const results = await publicClient.multicall({
        allowFailure: true,
        contracts: indexes.map((index) => ({
          address: PIXEL_NFT_CONTRACT_ADDRESS,
          abi: PixelNFTABI,
          functionName: "userTokens" as const,
          args: [addr, BigInt(index)] as const,
        })),
      });

      const ids = await Promise.all(results.map((result, resultIndex) => {
        if (result.status === "success") return Promise.resolve(result.result as bigint);
        const index = indexes[resultIndex];
        return withRetry(() =>
          publicClient.readContract({
            address: PIXEL_NFT_CONTRACT_ADDRESS,
            abi: PixelNFTABI,
            functionName: "userTokens",
            args: [addr, BigInt(index)],
          }) as Promise<bigint>
        );
      }));
      allIds.push(...ids);
    }

    const ids = Array.from(
      new Map(allIds.map((id) => [id.toString(), id] as const)).values()
    );
    if (ids.length !== n) {
      throw new Error(`Incomplete NFT enumeration: expected ${n}, received ${ids.length}`);
    }
    userNftCache.set(addr, ids);
    return ids.sort((a, b) => (a === b ? 0 : a < b ? -1 : 1));
  } catch (err) {
    console.error("[Contract] getUserTokenIds error:", err);
    // A previously enumerated list is better than an error, even past its ttl.
    const stale = userNftCache.entry(addr);
    if (stale?.value) return stale.value;
    userNftCache.set(addr, null);
    throw err;
  }
}
