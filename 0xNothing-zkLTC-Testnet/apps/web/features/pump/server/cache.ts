import "server-only";

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
 * Coalesce identical realtime reads and serve a very short stale snapshot when
 * an upstream indexer/RPC refresh briefly fails. This is process-local by
 * design, so it never changes the source of truth or on-chain semantics.
 */
export async function withPumpCache<T>(
  key: string,
  loader: () => Promise<T>,
  policy: CachePolicy,
): Promise<T> {
  const now = Date.now();
  const cached = values.get(key) as CacheEntry<T> | undefined;
  if (cached && cached.expiresAt > now) return cached.value;

  let pending = inFlight.get(key) as Promise<T> | undefined;
  if (!pending) {
    pending = loader();
    inFlight.set(key, pending);
  }

  try {
    const value = await pending;
    values.delete(key);
    values.set(key, {
      value,
      expiresAt: Date.now() + policy.ttlMs,
      staleAt: Date.now() + policy.ttlMs + (policy.staleMs ?? policy.ttlMs * 4),
    });
    trimCache();
    return value;
  } catch (error) {
    if (cached && cached.staleAt > Date.now()) return cached.value;
    throw error;
  } finally {
    if (inFlight.get(key) === pending) inFlight.delete(key);
  }
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
