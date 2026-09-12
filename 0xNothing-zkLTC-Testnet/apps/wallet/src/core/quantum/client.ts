import type { Hex } from "viem";
import { QUANTUM_RELAYER_URL } from "./config";

export interface RelayOutcome {
  ok: boolean;
  txHash?: Hex;
  error?: string;
}

/**
 * POST an already-signed intent to the sponsor relayer. The relayer validates
 * the policy, simulates the call and only then broadcasts with the sponsor key —
 * so a refused intent costs nobody any gas. The icon secret never leaves this
 * device; the request carries only the signature.
 */
export async function relay(raw: unknown): Promise<RelayOutcome> {
  let res: Response;
  try {
    res = await fetch(`${QUANTUM_RELAYER_URL}/relay`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(raw),
    });
  } catch (cause) {
    return {
      ok: false,
      error: `relayer unreachable at ${QUANTUM_RELAYER_URL}: ${(cause as Error).message}`,
    };
  }
  const body = (await res.json().catch(() => null)) as RelayOutcome | null;
  if (body === null) return { ok: false, error: `relayer HTTP ${res.status}` };
  return body;
}
