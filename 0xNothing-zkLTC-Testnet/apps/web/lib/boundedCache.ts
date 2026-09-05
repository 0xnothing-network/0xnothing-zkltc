/**
 * Bounded, keyed in-memory cache shared by the server-side data paths.
 *
 * Every route handler and RPC helper here needs the same three behaviours: a
 * freshness window, an entry ceiling so a long-lived server process cannot grow
 * without bound, and request coalescing so concurrent callers asking for one key
 * trigger a single upstream load. That trio used to be hand-rolled per file,
 * each with its own `Map`, its own `while (size > MAX)` eviction loop and its
 * own in-flight bookkeeping. It lives here once instead.
 *
 * Map insertion order doubles as the eviction order: writes and fresh reads
 * re-insert their key, so the first key is always the least recently used one.
 */

const DEFAULT_MAX_IN_FLIGHT = 128;

export interface BoundedCacheOptions {
  /** Hard ceiling on retained entries. The least recently used key is evicted first. */
  maxEntries: number;
  /** Default freshness window. Omit for entries that stay valid until evicted. */
  ttlMs?: number;
  /**
   * Ceiling on tracked concurrent loads. Past it `load` still runs the loader,
   * it just stops recording the promise, so a burst of distinct keys cannot pin
   * an unbounded number of pending requests in memory.
   */
  maxInFlight?: number;
}

export interface BoundedCacheEntry<T> {
  value: T;
  /** Milliseconds since the entry was written. */
  ageMs: number;
  /** False once the entry outlived its ttl but before eviction reclaims it. */
  fresh: boolean;
}

/**
 * A fixed freshness window, or one derived from the loaded value. The derived
 * form exists for negative caching: a "not found" answer usually deserves a much
 * shorter window than the answer it is standing in for.
 */
export type CacheTtl<T> = number | ((value: T) => number);

export interface BoundedCache<T> {
  /** The value while it is still fresh, otherwise undefined. Marks the key as recently used. */
  get(key: string): T | undefined;
  /** The stored entry including stale ones, for callers that serve stale data on failure. Marks the key as recently used. */
  entry(key: string): BoundedCacheEntry<T> | undefined;
  set(key: string, value: T, ttlMs?: number): void;
  delete(key: string): void;
  /** The load already in flight for this key, if any. */
  pending(key: string): Promise<T> | undefined;
  /** True once `maxInFlight` tracked loads are running. */
  saturated(): boolean;
  /**
   * Fresh cached value, else the in-flight load for the key, else a new load
   * whose result is cached. Rejections are never cached.
   */
  load(key: string, loader: () => Promise<T>, ttl?: CacheTtl<T>): Promise<T>;
  /**
   * Coalesced load that ignores the cached value. This is the revalidate half of
   * stale-while-revalidate: the caller has already answered from a stale entry
   * and now wants the next value written behind the response.
   */
  refresh(key: string, loader: () => Promise<T>, ttl?: CacheTtl<T>): Promise<T>;
  readonly size: number;
}

interface StoredEntry<T> {
  value: T;
  cachedAt: number;
  expiresAt: number;
}

export function createBoundedCache<T>(options: BoundedCacheOptions): BoundedCache<T> {
  const maxEntries = Math.max(1, Math.floor(options.maxEntries));
  const maxInFlight = Math.max(1, Math.floor(options.maxInFlight ?? DEFAULT_MAX_IN_FLIGHT));
  const values = new Map<string, StoredEntry<T>>();
  const inFlight = new Map<string, Promise<T>>();

  function store(key: string, value: T, ttlMs = options.ttlMs): void {
    values.delete(key);
    // A non-positive ttl means "do not retain". Callers use it for answers that
    // must be recomputed on the next request, such as an upstream outage.
    if (ttlMs !== undefined && ttlMs <= 0) return;
    const cachedAt = Date.now();
    values.set(key, {
      value,
      cachedAt,
      expiresAt: ttlMs === undefined ? Number.POSITIVE_INFINITY : cachedAt + ttlMs,
    });
    while (values.size > maxEntries) {
      const oldestKey = values.keys().next().value;
      if (oldestKey === undefined) return;
      values.delete(oldestKey);
    }
  }

  function set(key: string, value: T, ttlMs = options.ttlMs): void {
    // A forced result supersedes any older load of the same key. Existing
    // callers may finish, but their result must not replace this newer value.
    inFlight.delete(key);
    store(key, value, ttlMs);
  }

  function touch(key: string, stored: StoredEntry<T>): void {
    values.delete(key);
    values.set(key, stored);
  }

  function get(key: string): T | undefined {
    const stored = values.get(key);
    if (!stored || stored.expiresAt <= Date.now()) return undefined;
    touch(key, stored);
    return stored.value;
  }

  function refresh(key: string, loader: () => Promise<T>, ttl: CacheTtl<T> | undefined = options.ttlMs): Promise<T> {
    const pending = inFlight.get(key);
    if (pending) return pending;

    const loaded = Promise.resolve().then(loader);
    if (inFlight.size >= maxInFlight) return loaded;
    const request = loaded
      .then((value) => {
        if (inFlight.get(key) === request) {
          store(key, value, typeof ttl === "function" ? ttl(value) : ttl);
        }
        return value;
      })
      .finally(() => {
        if (inFlight.get(key) === request) inFlight.delete(key);
      });
    inFlight.set(key, request);
    return request;
  }

  function load(key: string, loader: () => Promise<T>, ttl: CacheTtl<T> | undefined = options.ttlMs): Promise<T> {
    const cached = get(key);
    return cached !== undefined ? Promise.resolve(cached) : refresh(key, loader, ttl);
  }

  return {
    get,
    set,
    load,
    refresh,
    entry(key) {
      const stored = values.get(key);
      if (!stored) return undefined;
      // Reading through `entry` is still a read, so it has to count as a use.
      // Callers that serve stale-while-revalidate never touch `get`, and without
      // this their hottest keys aged out purely by write order: a market read on
      // every grid render would be evicted ahead of a key nobody had asked for
      // since it was stored.
      touch(key, stored);
      const now = Date.now();
      return { value: stored.value, ageMs: now - stored.cachedAt, fresh: stored.expiresAt > now };
    },
    delete(key) {
      values.delete(key);
      inFlight.delete(key);
    },
    pending(key) {
      return inFlight.get(key);
    },
    saturated() {
      return inFlight.size >= maxInFlight;
    },
    get size() {
      return values.size;
    },
  };
}
