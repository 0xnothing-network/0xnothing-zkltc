import { BaseError, fallback, http, HttpRequestError, TimeoutError, type HttpTransportConfig } from "viem";
import { LITVM_RPC_URL } from "./publicConfig";

/** Ordered, de-duplicated RPC endpoints: an explicit override first, then the default. */
export function litvmRpcUrls(primary: string = LITVM_RPC_URL): string[] {
  return Array.from(new Set([primary, LITVM_RPC_URL].filter(Boolean)));
}

/**
 * LiteForge transport. An overridden endpoint fails over to the default one when it
 * errors or times out. Each endpoint keeps the caller's batching/timeout settings.
 *
 * The caller's retryCount is the only retry budget (one retry when it names none).
 * A fallback-level retry on top multiplied it: with the single LiteForge endpoint a
 * hung call waited through every attempt twice, 90 s for a 15 s timeout with 2 retries.
 */
export function litvmTransport(options: HttpTransportConfig = {}, primary?: string) {
  const transports = litvmRpcUrls(primary).map((url) => http(url, { retryCount: 1, ...options }));
  return transports.length === 1 ? transports[0] : fallback(transports, { retryCount: 0 });
}

/** JSON-RPC codes a node answers with when it is overloaded: internal error, limit exceeded, resource unavailable, rate limits. */
const OVERLOADED_RPC_CODES = new Set([-32603, -32005, -32002, -32007, 429]);

/**
 * True when a read failed in transit (timeout, HTTP error, overloaded node) rather
 * than because the contract reverted or lacks the function. Callers that cache a
 * placeholder for a failed read keep it only briefly in this case.
 *
 * A gateway often reports overload as a JSON-RPC error body, which viem surfaces as
 * an RpcRequestError and may even relabel as a revert. Revert data is what tells a
 * real revert apart, so an error code only counts when no revert data came with it.
 */
export function isTransientRpcError(error: unknown): boolean {
  if (!(error instanceof BaseError)) return false;
  let lostInTransit = false;
  let overloaded = false;
  let revertData = false;
  error.walk((cause) => {
    if (cause instanceof HttpRequestError || cause instanceof TimeoutError) lostInTransit = true;
    const { code, status, data, raw } = (cause ?? {}) as { code?: unknown; status?: unknown; data?: unknown; raw?: unknown };
    if (typeof status === "number" && status >= 400) overloaded = true;
    if (typeof code === "number" && OVERLOADED_RPC_CODES.has(code)) overloaded = true;
    if ([data, raw].some((value) => typeof value === "string" && value.length > 2)) revertData = true;
    return false;
  });
  return lostInTransit || (overloaded && !revertData);
}
