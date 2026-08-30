export interface SlidingWindowRateLimitOptions {
  windowMs: number;
  maxAttempts: number;
  maxKeys: number;
}

export interface SlidingWindowRateLimiter {
  consume(keys: readonly string[], now?: number): boolean;
  prune(now?: number): void;
  size(): number;
}

/**
 * In-process guard for small, deployment-local abuse boundaries.
 *
 * A request may carry several identities (for example wallet and client IP).
 * They are checked as one admission decision so a rejected request never
 * consumes only a subset of its quotas. Re-inserting touched rows gives the
 * bounded map real LRU semantics instead of evicting an actively used key.
 */
export function createSlidingWindowRateLimiter(
  options: SlidingWindowRateLimitOptions,
): SlidingWindowRateLimiter {
  const windowMs = positiveInteger(options.windowMs, "windowMs");
  const maxAttempts = positiveInteger(options.maxAttempts, "maxAttempts");
  const maxKeys = positiveInteger(options.maxKeys, "maxKeys");
  const history = new Map<string, number[]>();

  function recent(key: string, now: number): number[] {
    return (history.get(key) ?? []).filter((timestamp) => timestamp > now - windowMs);
  }

  function touch(key: string, timestamps: number[]): void {
    history.delete(key);
    if (timestamps.length > 0) history.set(key, timestamps);
  }

  function evictOne(protectedKeys: ReadonlySet<string>): boolean {
    for (const key of history.keys()) {
      if (protectedKeys.has(key)) continue;
      history.delete(key);
      return true;
    }
    return false;
  }

  function consume(keys: readonly string[], now = Date.now()): boolean {
    if (!Number.isFinite(now)) return false;
    const uniqueKeys = [...new Set(keys.filter((key) => key.length > 0))];
    if (uniqueKeys.length === 0 || uniqueKeys.length > maxKeys) return false;

    const windows = new Map(uniqueKeys.map((key) => [key, recent(key, now)]));
    const allowed = [...windows.values()].every((timestamps) => timestamps.length < maxAttempts);
    if (!allowed) {
      // Prune expired entries and keep active identities at the hot end without
      // debiting any of the request's other quotas.
      for (const [key, timestamps] of windows) touch(key, timestamps);
      return false;
    }

    const protectedKeys = new Set(uniqueKeys);
    for (const key of uniqueKeys) {
      if (!history.has(key)) {
        while (history.size >= maxKeys) {
          if (!evictOne(protectedKeys)) return false;
        }
      }
      const timestamps = windows.get(key) ?? [];
      timestamps.push(now);
      touch(key, timestamps);
    }
    return true;
  }

  function prune(now = Date.now()): void {
    if (!Number.isFinite(now)) return;
    for (const key of [...history.keys()]) touch(key, recent(key, now));
  }

  return {
    consume,
    prune,
    size: () => history.size,
  };
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer`);
  }
  return value;
}
