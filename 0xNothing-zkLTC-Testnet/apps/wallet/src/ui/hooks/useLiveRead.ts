import { useCallback, useEffect, useRef, useState } from "react";
import { describeError } from "../../core/lib/errors";
import { subscribeBlocks } from "../../core/rpc/blockTicker";

/**
 * The one read hook. `load` runs on mount, whenever `deps` change, and — unless
 * `live` is switched off — on every new block, which is what makes the wallet
 * update without a refresh control. Results from a superseded run are dropped,
 * so a slow answer can never overwrite a newer one.
 *
 * `deps` must keep a constant length across renders, exactly like a dependency
 * array passed to useEffect directly.
 */
export interface LiveRead<T> {
  data: T | null;
  error: string | null;
  /** True only while a load with no data yet is in flight. */
  loading: boolean;
  /** True while any load is in flight, including a background refresh. */
  busy: boolean;
  reload: () => void;
}

interface ReadState<T> {
  key: object;
  data: T | null;
  error: string | null;
  busy: boolean;
}

function sameDeps(left: readonly unknown[], right: readonly unknown[]): boolean {
  return left.length === right.length && left.every((value, index) => Object.is(value, right[index]));
}

export function useLiveRead<T>(
  load: (() => Promise<T>) | null,
  deps: readonly unknown[],
  options: {
    live?: boolean;
    /**
     * Dependencies that identify the value being read. Dependencies omitted
     * here still trigger a refresh, but keep the last value on screen while it
     * runs (a block/manual tick is the usual example).
     */
    identity?: readonly unknown[];
    /** Debounce dependency-triggered reads; block/manual reloads stay instant. */
    debounceMs?: number;
  } = {},
): LiveRead<T> {
  const loadRef = useRef(load);
  loadRef.current = load;

  const identity = options.identity ?? deps;
  const enabled = load !== null;
  const identityRef = useRef<{
    values: readonly unknown[];
    enabled: boolean;
    key: object;
  } | null>(null);
  if (
    identityRef.current === null
    || identityRef.current.enabled !== enabled
    || !sameDeps(identityRef.current.values, identity)
  ) {
    identityRef.current = { values: [...identity], enabled, key: {} };
  }
  const key = identityRef.current.key;

  const [state, setState] = useState<ReadState<T> | null>(null);
  const mountedRef = useRef(false);
  const lifecycleRef = useRef(0);
  const enabledRef = useRef(enabled);
  const currentKeyRef = useRef(key);
  const activeRef = useRef<{ id: number; key: object } | null>(null);
  const queuedRef = useRef<object | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const nextRequestId = useRef(0);
  const scheduleRef = useRef<(nextKey: object) => void>(() => {});
  enabledRef.current = enabled;
  currentKeyRef.current = key;

  const schedule = useCallback((nextKey: object): void => {
    if (
      !mountedRef.current
      || !enabledRef.current
      || currentKeyRef.current !== nextKey
    ) return;

    // A slow RPC never fans out into one request per block or keystroke. Keep
    // only the newest requested generation and run it when the active request
    // settles.
    if (activeRef.current !== null) {
      queuedRef.current = nextKey;
      return;
    }

    const run = loadRef.current;
    if (run === null) return;
    const id = ++nextRequestId.current;
    const lifecycle = lifecycleRef.current;
    activeRef.current = { id, key: nextKey };
    setState((previous) => ({
      key: nextKey,
      data: previous?.key === nextKey ? previous.data : null,
      error: null,
      busy: true,
    }));

    const canCommit = (): boolean =>
      mountedRef.current
      && lifecycleRef.current === lifecycle
      && enabledRef.current
      && currentKeyRef.current === nextKey
      && activeRef.current?.id === id;

    // The Promise boundary also catches loaders that throw synchronously while
    // constructing arguments (malformed dapp quantities are one real case).
    Promise.resolve()
      .then(run)
      .then((value) => {
        if (canCommit()) {
          setState({ key: nextKey, data: value, error: null, busy: false });
        }
      })
      .catch((cause: unknown) => {
        if (!canCommit()) return;
        setState((previous) => ({
          key: nextKey,
          data: previous?.key === nextKey ? previous.data : null,
          error: describeError(cause),
          busy: false,
        }));
      })
      .finally(() => {
        if (activeRef.current?.id !== id) return;
        activeRef.current = null;
        const queued = queuedRef.current;
        queuedRef.current = null;
        if (
          queued !== null
          && mountedRef.current
          && enabledRef.current
          && currentKeyRef.current === queued
        ) scheduleRef.current(queued);
      });
  }, []);
  scheduleRef.current = schedule;

  const clearDebounce = useCallback((): void => {
    if (timerRef.current === null) return;
    clearTimeout(timerRef.current);
    timerRef.current = null;
  }, []);

  const refresh = useCallback(() => {
    clearDebounce();
    scheduleRef.current(currentKeyRef.current);
  }, [clearDebounce]);

  useEffect(() => {
    mountedRef.current = true;
    lifecycleRef.current += 1;
    return () => {
      mountedRef.current = false;
      lifecycleRef.current += 1;
      queuedRef.current = null;
      clearDebounce();
    };
  }, [clearDebounce]);

  useEffect(() => {
    if (!enabled) {
      queuedRef.current = null;
      clearDebounce();
      return;
    }
    const delay = Math.max(0, options.debounceMs ?? 0);
    if (delay === 0) {
      scheduleRef.current(key);
      return;
    }
    clearDebounce();
    const timer = setTimeout(() => {
      if (timerRef.current === timer) timerRef.current = null;
      scheduleRef.current(key);
    }, delay);
    timerRef.current = timer;
    return () => {
      if (timerRef.current !== timer) return;
      clearTimeout(timer);
      timerRef.current = null;
    };
  }, [clearDebounce, enabled, key, options.debounceMs, ...deps]);

  const live = options.live !== false && load !== null;
  useEffect(() => {
    if (!live) return;
    return subscribeBlocks(refresh);
  }, [live, refresh]);

  // An identity change invalidates the previous value during render, before
  // the effect for the new request runs. Refresh-only dependencies and block
  // updates keep the last good value visible while their request is pending.
  const current = enabled && state?.key === key ? state : null;
  const data = current?.data ?? null;
  const busy = enabled && (current?.busy ?? true);

  return {
    data,
    error: current?.error ?? null,
    loading: busy && data === null,
    busy,
    reload: refresh,
  };
}
