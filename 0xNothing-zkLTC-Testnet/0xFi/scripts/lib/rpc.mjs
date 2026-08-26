import process from "node:process";

import { createPublicClient, fallback, http } from "viem";

/**
 * JSON-RPC batching, matching the web client and the API route handlers: one
 * HTTP request per burst of eth_calls. Audit and keeper scans issue hundreds of
 * reads per pass, so this is the difference between one request and hundreds.
 */
export const RPC_BATCH_OPTIONS = { batch: { batchSize: 100, wait: 10 } };

/**
 * Resolve the first non-empty endpoint from an ordered candidate list.
 *
 * Fails closed with the variable name instead of letting `.trim()` throw a bare
 * TypeError, so an unconfigured network file says what to set.
 */
export function resolveEndpoint(label, ...candidates) {
  const value = candidates.find((candidate) => typeof candidate === "string" && candidate.trim().length > 0);
  if (!value) throw new Error(`${label} is not configured`);
  return value.trim();
}

/** Primary RPC endpoint: env override first, then the checked network file. */
export function primaryRpcUrl(network) {
  return resolveEndpoint("LITEFORGE_RPC_URL", process.env.LITEFORGE_RPC_URL, network?.rpcUrl);
}

/** Fallback RPC endpoint. `extraCandidates` keeps a caller's own default in play. */
export function fallbackRpcUrl(network, ...extraCandidates) {
  return resolveEndpoint(
    "LITEFORGE_FALLBACK_RPC_URL",
    process.env.LITEFORGE_FALLBACK_RPC_URL,
    network?.fallbackRpcUrl,
    ...extraCandidates,
  );
}

/**
 * Read-only client over both endpoints with batching enabled.
 * `extraFallbackCandidates` is appended to the fallback candidate list.
 */
export function createRpcClient(network, ...extraFallbackCandidates) {
  return createPublicClient({
    transport: fallback([
      http(primaryRpcUrl(network), RPC_BATCH_OPTIONS),
      http(fallbackRpcUrl(network, ...extraFallbackCandidates), RPC_BATCH_OPTIONS),
    ]),
  });
}
