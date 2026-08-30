import { type Address, createPublicClient, createWalletClient, http } from "viem";
import { LITVM_NETWORK, type WalletNetwork, viemChainFor } from "../../config/networks";
import { signerFor } from "../keyring/vault";

/**
 * Transport settings mirror apps/web/lib/contract.ts so the wallet behaves
 * exactly like the site against the same RPC: requests inside a 10 ms window
 * are merged into one JSON-RPC batch, and multicall aggregation is on.
 */
function transportFor(network: WalletNetwork) {
  return http(network.rpcUrl, {
    batch: { batchSize: 100, wait: 10 },
    retryCount: 2,
    retryDelay: 300,
    timeout: 15_000,
  });
}

function clientFor(network: WalletNetwork) {
  return createPublicClient({
    chain: viemChainFor(network),
    transport: transportFor(network),
    batch: { multicall: { batchSize: 16_384 } },
  });
}

/** The selected profile is changed only after it has passed config validation. */
export let activeNetwork: WalletNetwork = LITVM_NETWORK;
export let publicClient = clientFor(LITVM_NETWORK);

export function configureRpcClient(network: WalletNetwork): void {
  if (activeNetwork.id === network.id && activeNetwork.rpcUrl === network.rpcUrl) return;
  activeNetwork = network;
  publicClient = clientFor(network);
}

/** A signing client for one account. Built per use; nothing is cached. */
export async function walletClientFor(address: Address, network: WalletNetwork = activeNetwork) {
  return createWalletClient({
    account: await signerFor(address),
    chain: viemChainFor(network),
    transport: transportFor(network),
  });
}

const RATE_LIMIT_HINTS = [
  "bandwidth limit",
  "rate limit",
  "429",
  "limit exceeded",
  "too many requests",
];

function isRateLimited(error: unknown): boolean {
  const text = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return RATE_LIMIT_HINTS.some((hint) => text.includes(hint));
}

/**
 * Retries only throttling. A revert, a bad address or a malformed call is
 * deterministic — retrying it wastes the user's time and hides the real error.
 */
export async function withRetry<T>(run: () => Promise<T>, attempts = 3): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await run();
    } catch (error) {
      if (!isRateLimited(error)) throw error;
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** attempt));
    }
  }
  throw lastError;
}
