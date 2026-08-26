import "server-only";

import { after } from "next/server";
import { createBoundedCache } from "@/lib/boundedCache";

interface CachePolicy {
  ttlMs: number;
  staleMs?: number;
}

const MAX_ENTRIES = 512;
// The shared cache holds each entry for its full stale horizon; `withPumpCache`
// compares the entry age against the policy ttl to tell fresh from stale.
const cache = createBoundedCache<unknown>({ maxEntries: MAX_ENTRIES, maxInFlight: MAX_ENTRIES });

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
    after(() => cache.refresh(key, load, retentionMs(policy)).then(() => undefined).catch(() => undefined));
    return cached.value as T;
  }

  return cache.refresh(key, load, retentionMs(policy)) as Promise<T>;
}
