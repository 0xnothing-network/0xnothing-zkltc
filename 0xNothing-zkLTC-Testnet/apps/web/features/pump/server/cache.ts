import "server-only";

import { after } from "next/server";
import { createBoundedCache } from "@/lib/boundedCache";

interface CachePolicy {
  ttlMs: number;
  staleMs?: number;
  /** Wait for a reload instead of answering from an entry past its ttl. */
  fresh?: boolean;
}

const MAX_ENTRIES = 512;
// Every distinct query string is its own key, and each miss is a subgraph request
// and often RPC reads. Past this many loads at once, a key that is not already
// loading is refused instead of joining the pile. The limit leaves room for the slow
// case: with the index down, each token page being viewed holds three multi-second
// RPC scans (candles, trades, holders) at once.
const MAX_CONCURRENT_LOADS = 96;
// The shared cache holds each entry for its full stale horizon; `withPumpCache`
// compares the entry age against the policy ttl to tell fresh from stale.
const cache = createBoundedCache<unknown>({ maxEntries: MAX_ENTRIES, maxInFlight: MAX_CONCURRENT_LOADS });

/** Thrown for a read that would start a new upstream load while the cache is saturated. */
export class PumpCacheBusyError extends Error {
  constructor() {
    super("Pump read cache is saturated");
    this.name = "PumpCacheBusyError";
  }
}

function mayStartLoad(key: string): boolean {
  return !cache.saturated() || cache.pending(key) !== undefined;
}

function retentionMs(policy: CachePolicy): number {
  return policy.ttlMs + (policy.staleMs ?? policy.ttlMs * 4);
}

/**
 * Coalesce identical reads and serve a short stale snapshot while the next
 * indexer/RPC refresh runs after the response. This cache is process-local;
 * public route headers provide the shared CDN layer.
 */
export async function withPumpCache<T>(
  key: string,
  loader: () => Promise<T>,
  policy: CachePolicy,
): Promise<T> {
  const load = loader as () => Promise<unknown>;
  const cached = cache.entry(key);
  if (cached?.fresh) {
    if (cached.ageMs < policy.ttlMs) return cached.value as T;
    // Under saturation the snapshot in hand is the answer; its refresh waits for a calmer poll.
    if (!mayStartLoad(key)) return cached.value as T;
    if (policy.fresh) return cache.refresh(key, load, retentionMs(policy)) as Promise<T>;
    after(() => cache.refresh(key, load, retentionMs(policy)).then(() => undefined).catch(() => undefined));
    return cached.value as T;
  }

  if (!mayStartLoad(key)) throw new PumpCacheBusyError();
  return cache.refresh(key, load, retentionMs(policy)) as Promise<T>;
}
