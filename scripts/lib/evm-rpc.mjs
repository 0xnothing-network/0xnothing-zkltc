import { readLimitedJsonResponse } from "./http-json.mjs";

const ABI_ADDRESS_WORD = /^0x[0-9a-fA-F]{64}$/u;
const ZERO_PADDING = "0".repeat(24);

export function decodeEvmAddressWord(value, label = "EVM address") {
  if (typeof value !== "string" || !ABI_ADDRESS_WORD.test(value)) {
    throw new Error(`${label} returned malformed address data`);
  }
  if (value.slice(2, 26) !== ZERO_PADDING) {
    throw new Error(`${label} returned non-zero ABI address padding`);
  }
  return `0x${value.slice(-40)}`.toLowerCase();
}

export async function requestJsonRpc(url, method, params = [], {
  fetchImpl = fetch,
  maxResponseBytes = 256 * 1024,
  timeoutMs = 10_000,
} = {}) {
  const id = 1;
  const response = await fetchImpl(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`${method} returned HTTP ${response.status}`);

  const payload = await readLimitedJsonResponse(response, {
    label: method,
    maxBytes: maxResponseBytes,
  });
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error(`${method} returned an invalid JSON-RPC payload`);
  }
  if (payload.jsonrpc !== "2.0" || payload.id !== id) {
    throw new Error(`${method} returned a mismatched JSON-RPC response`);
  }
  if (payload.error || typeof payload.result !== "string") {
    const remoteMessage = typeof payload.error?.message === "string"
      ? payload.error.message.slice(0, 500)
      : `${method} returned no result`;
    throw new Error(remoteMessage);
  }
  return payload.result;
}
