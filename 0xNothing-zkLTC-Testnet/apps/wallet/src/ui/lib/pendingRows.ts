/**
 * Home's pending rows. A row seen pending on this Home stays listed after it
 * settles, so the user sees it turn to success or failed in place rather than
 * vanish, for about a minute (trackPending); a row that was already settled when Home opened is History's job.
 */
export const MAX_HOME_PENDING = 3;

interface Row {
  hash: string;
  status: string;
  at: number;
}

/** `prev` plus the hashes of pending rows; `prev` itself when nothing is new, so state does not churn. */
export function watchPending(prev: ReadonlySet<string>, rows: readonly Row[]): ReadonlySet<string> {
  const fresh = rows.filter((row) => row.status === "pending" && !prev.has(row.hash));
  if (fresh.length === 0) return prev;
  return new Set([...prev, ...fresh.map((row) => row.hash)]);
}

/** The rows Home shows: pending or watched, newest first, at most `max`. */
export function pendingRows<T extends Row>(
  rows: readonly T[],
  watched: ReadonlySet<string>,
  max = MAX_HOME_PENDING,
): T[] {
  return rows
    .filter((row) => row.status === "pending" || watched.has(row.hash))
    .sort((a, b) => b.at - a.at)
    .slice(0, max);
}

/** How long a row stays on Home after it was first seen settled. */
export const SETTLED_SHOWN_MS = 60_000;

/** The hashes Home watches and when each was first seen settled. */
export interface PendingWatch {
  hashes: ReadonlySet<string>;
  settledAt: ReadonlyMap<string, number>;
}

export const EMPTY_WATCH: PendingWatch = { hashes: new Set(), settledAt: new Map() };

/**
 * watchPending, plus an end: a watched row leaves about a minute after it was
 * first seen settled. Home in a side panel can stay open for hours, and settled
 * rows would otherwise hold the slots above the token list for good. `prev`
 * itself when nothing changes, so state does not churn.
 */
export function trackPending(prev: PendingWatch, rows: readonly Row[], now: number): PendingWatch {
  let hashes = watchPending(prev.hashes, rows);
  let settledAt = prev.settledAt;
  const status = new Map(rows.map((row) => [row.hash, row.status]));
  for (const hash of hashes) {
    const settled = status.has(hash) && status.get(hash) !== "pending";
    const since = settledAt.get(hash);
    if (settled && since === undefined) {
      settledAt = new Map(settledAt).set(hash, now);
    } else if (since !== undefined && now - since >= SETTLED_SHOWN_MS) {
      const keptHashes = new Set(hashes);
      keptHashes.delete(hash);
      hashes = keptHashes;
      const kept = new Map(settledAt);
      kept.delete(hash);
      settledAt = kept;
    }
  }
  return hashes === prev.hashes && settledAt === prev.settledAt ? prev : { hashes, settledAt };
}
