"use client";

import { useEffect, useRef } from "react";

/**
 * Shared polling jitter for every live query in the app. 0xPump and 0xFi used to
 * carry byte-identical copies of this logic, which also meant two independent
 * seeds: one browser could still align a 0xPump tick with a 0xFi tick. One seed
 * per browser keeps every section's refetch schedule mutually offset.
 */
let browserSeed: number | undefined;

const INTERVAL_JITTER_RANGE = 3_001;
const VISIBILITY_JITTER_RANGE = 1_501;

function hashKey(key: string): number {
  let hash = 0;
  for (let index = 0; index < key.length; index += 1) {
    hash = ((hash << 5) - hash + key.charCodeAt(index)) | 0;
  }
  return hash >>> 0;
}

/**
 * Deterministic per-key offset, seeded once per browser. The same key always gets
 * the same offset inside one session, so an interval never drifts, while two
 * visitors never queue their refetches on the same millisecond.
 */
function pollOffset(key: string, range: number): number {
  if (browserSeed === undefined && typeof window !== "undefined") {
    const random = new Uint32Array(1);
    window.crypto.getRandomValues(random);
    browserSeed = random[0];
  }
  return (hashKey(key) + (browserSeed ?? 0)) % range;
}

export function jitteredPollInterval(key: string, baseInterval: number): number {
  return baseInterval + pollOffset(key, INTERVAL_JITTER_RANGE);
}

export type VisibilityRefreshOptions = {
  key: string;
  dataUpdatedAt: number;
  enabled?: boolean;
  isFetching: boolean;
  refetch: () => Promise<unknown>;
  maxAgeMs: number;
};

/**
 * Refetches once a hidden tab comes back and its data has aged past `maxAgeMs`.
 * Reads live values through refs so the listener subscribes once instead of on
 * every fetch state change.
 */
export function useVisibilityRefresh({
  key,
  dataUpdatedAt,
  enabled = true,
  isFetching,
  refetch,
  maxAgeMs,
}: VisibilityRefreshOptions): void {
  const refetchRef = useRef(refetch);
  const dataUpdatedAtRef = useRef(dataUpdatedAt);
  const enabledRef = useRef(enabled);
  const isFetchingRef = useRef(isFetching);

  useEffect(() => {
    refetchRef.current = refetch;
    dataUpdatedAtRef.current = dataUpdatedAt;
    enabledRef.current = enabled;
    isFetchingRef.current = isFetching;
  }, [dataUpdatedAt, enabled, isFetching, refetch]);

  useEffect(() => {
    let timer: number | undefined;
    const clearTimer = () => {
      if (timer !== undefined) window.clearTimeout(timer);
      timer = undefined;
    };
    const onVisibilityChange = () => {
      clearTimer();
      if (!enabledRef.current) return;
      if (document.visibilityState !== "visible" || isFetchingRef.current) return;
      if (Date.now() - dataUpdatedAtRef.current < maxAgeMs) return;
      timer = window.setTimeout(
        () => void refetchRef.current(),
        pollOffset(key, VISIBILITY_JITTER_RANGE),
      );
    };

    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      clearTimer();
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [enabled, key, maxAgeMs]);
}
