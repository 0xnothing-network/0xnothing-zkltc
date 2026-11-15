import type { Hex } from "viem";
import type { TxKind, TxRecord } from "../../core/services/history";

/**
 * What History says about a transaction whose broadcast answer was lost.
 * Until it settles the screen keeps Confirm off: the node may already hold it,
 * and a retry would sign a second copy on the next nonce.
 *
 * - "pending": still in flight, keep holding.
 * - "missing": no row yet. The row is written when the transaction is signed,
 *   but that write is fire-and-forget, so a missing row is not proof of
 *   anything; the hook decides with missingRowReleases.
 * - "sent": the screen's own job was mined. It went through, so the screen runs
 *   its success path and never hands the same review back to Confirm.
 * - "retry": failed, dropped, or a step of another kind (an approval) that
 *   settled: the job itself did not go out, so Confirm comes back.
 */
export type BroadcastOutcome = "pending" | "missing" | "sent" | "retry";

/** How long a held hash may be missing from History before it stops holding. */
export const BROADCAST_ROW_GRACE_MS = 2 * 60_000;
/**
 * A pending row older than this does not hold a freshly opened screen. A
 * transaction the node never received stays pending until the nonce moves on,
 * which only another send does; without a bound the screen would never let it.
 * Same window as the Send draft, so a restored form is always still held.
 */
export const BROADCAST_SEED_MAX_AGE_MS = 10 * 60_000;
/** A clock a little ahead on the writing side must not make a row hold for ever. */
const FUTURE_SKEW_MS = 60_000;

export function broadcastOutcome(
  rows: readonly TxRecord[],
  hash: Hex,
  kinds: readonly TxKind[],
): BroadcastOutcome {
  const row = rows.find((entry) => entry.hash.toLowerCase() === hash.toLowerCase());
  if (row === undefined) return "missing";
  if (row.status === "pending") return "pending";
  return row.status === "success" && kinds.includes(row.kind) ? "sent" : "retry";
}

/** A missing row stops holding once it was seen and then went, or after the grace. */
export function missingRowReleases(seen: boolean, heldAt: number, now: number): boolean {
  return seen || now - heldAt >= BROADCAST_ROW_GRACE_MS;
}

/**
 * The hash a screen opened afresh should hold: the newest recent row of its own
 * kinds still pending. The in-memory hold dies with the popup, a second surface
 * or an Android relaunch; History does not.
 */
export function seedBroadcastHold(
  rows: readonly TxRecord[],
  kinds: readonly TxKind[],
  now: number,
): Hex | null {
  let newest: TxRecord | null = null;
  for (const row of rows) {
    if (row.status !== "pending" || !kinds.includes(row.kind)) continue;
    if (now - row.at > BROADCAST_SEED_MAX_AGE_MS || row.at - now > FUTURE_SKEW_MS) continue;
    if (newest === null || row.at > newest.at) newest = row;
  }
  return newest?.hash ?? null;
}
