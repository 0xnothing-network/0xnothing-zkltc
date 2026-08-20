import "server-only";

import { after } from "next/server";

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
  staleAt: number;
}

interface CachePolicy {
  ttlMs: number;
  staleMs?: number;
}

const MAX_ENTRIES = 512;
const values = new Map<string, CacheEntry<unknown>>();
const inFlight = new Map<string, Promise<unknown>>();

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
  const now = Date.now();
  const cached = values.get(key) as CacheEntry<T> | undefined;
  if (cached && cached.expiresAt > now) return cached.value;

  if (cached && cached.staleAt > now) {
    after(() => refreshCache(key, loader, policy).then(() => undefined).catch(() => undefined));
    return cached.value;
  }

  return refreshCache(key, loader, policy);
}

function refreshCache<T>(
  key: string,
  loader: () => Promise<T>,
  policy: CachePolicy,
): Promise<T> {
  const existing = inFlight.get(key) as Promise<T> | undefined;
  if (existing) return existing;

  const pending = loader().then((value) => {
    const cachedAt = Date.now();
    values.delete(key);
    values.set(key, {
      value,
      expiresAt: cachedAt + policy.ttlMs,
      staleAt: cachedAt + policy.ttlMs + (policy.staleMs ?? policy.ttlMs * 4),
    });
    trimCache();
    return value;
  });
  inFlight.set(key, pending);
  void pending.finally(() => {
    if (inFlight.get(key) === pending) inFlight.delete(key);
  }).catch(() => undefined);
  return pending;
}

function trimCache(): void {
  const now = Date.now();
  for (const [key, entry] of values) {
    if (entry.staleAt <= now) values.delete(key);
  }
  while (values.size > MAX_ENTRIES) {
    const oldest = values.keys().next().value;
    if (oldest === undefined) return;
    values.delete(oldest);
  }
}
