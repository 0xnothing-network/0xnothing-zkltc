import type { Hex } from "viem";
import { QUANTUM_RELAYER_URL } from "./config";

/**
 * Client half of the intent bulletin board (quantum-wallet/relayer/src/board.ts).
 *
 * This is the user-facing escape hatch of last resort but one. When the sponsor
 * relayer refuses or is down, a signed intent has three futures:
 *
 *   1. retry the sponsor            — free, but useless if the sponsor is gone
 *   2. post it here                 — free, and someone else pays the gas
 *   3. broadcast it yourself        — always works, and costs the user gas
 *
 * Posting is strictly better than (3) for the user's wallet and strictly worse
 * for their privacy: the board is public, so the intent — who is paying whom,
 * and how much — becomes visible to everyone a few seconds before the chain
 * would have shown it anyway. That is a real trade and the reason this is never
 * automatic. Nothing is posted unless the user asks for it.
 *
 * The signature is what makes posting safe: it commits to the wallet, the chain,
 * the nonce and every call, so a hostile board can drop the intent or leak it
 * but cannot alter a byte of it. The exact bytes already on disk are sent — this
 * module cannot sign and never re-derives anything.
 */

export interface BoardPostResult {
  ok: boolean;
  id?: string;
  duplicate?: boolean;
  error?: string;
}

function boardBase(url: string = QUANTUM_RELAYER_URL): string {
  return url.replace(/\/$/u, "");
}

/**
 * Publish an already-signed intent. Idempotent: re-posting the same bytes
 * refreshes the existing entry instead of creating a second one, which matters
 * because retrying must never mean re-signing.
 */
export async function postIntent(request: unknown, url?: string): Promise<BoardPostResult> {
  let res: Response;
  try {
    res = await fetch(`${boardBase(url)}/intents`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
    });
  } catch (cause) {
    return { ok: false, error: `board unreachable: ${(cause as Error).message}` };
  }
  const text = await res.text();
  try {
    const parsed = JSON.parse(text) as BoardPostResult;
    // A board that answers 200 with no `ok` field is not one to trust with a
    // silent success — surface the ambiguity instead of inventing a result.
    if (typeof parsed.ok !== "boolean") return { ok: false, error: text || `board error ${res.status}` };
    return parsed;
  } catch {
    return { ok: false, error: text || `board error ${res.status}` };
  }
}

export interface BoardHealth {
  relayHub: Hex | null;
  chainId: number | null;
  size: number | null;
}

/** Read the board's advertised hub + queue depth, for display only. */
export async function boardHealth(url?: string): Promise<BoardHealth | null> {
  try {
    const res = await fetch(`${boardBase(url)}/health`);
    if (!res.ok) return null;
    const body = (await res.json()) as Record<string, unknown>;
    const board = body.board as Record<string, unknown> | undefined;
    return {
      relayHub: typeof body.relayHub === "string" ? (body.relayHub as Hex) : null,
      chainId: Number.isFinite(Number(body.chainId)) ? Number(body.chainId) : null,
      size: board && Number.isFinite(Number(board.size)) ? Number(board.size) : null,
    };
  } catch {
    return null;
  }
}
