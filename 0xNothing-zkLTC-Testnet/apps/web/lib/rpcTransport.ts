import { fallback, http, type HttpTransportConfig } from "viem";
import { LITVM_RPC_FALLBACK_URL, LITVM_RPC_URL } from "./publicConfig";

/** Ordered, de-duplicated RPC endpoints: an explicit override first, then the defaults. */
export function litvmRpcUrls(primary: string = LITVM_RPC_URL): string[] {
  return Array.from(new Set([primary, LITVM_RPC_URL, LITVM_RPC_FALLBACK_URL].filter(Boolean)));
}

/**
 * LiteForge transport that fails over to the next endpoint when one errors or times
 * out, so a single provider change does not take the site down. Each endpoint keeps
 * the caller's batching/timeout settings.
 */
export function litvmTransport(options: HttpTransportConfig = {}, primary?: string) {
  return fallback(litvmRpcUrls(primary).map((url) => http(url, options)), { retryCount: 1 });
}
