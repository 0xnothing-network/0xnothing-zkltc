"use client";

import { useEffect, useRef } from "react";
import { LIVE_MS } from "@/lib/liveData";

let browserSeed: number | undefined;

function hashKey(key: string): number {
  let hash = 0;
  for (let index = 0; index < key.length; index += 1) {
    hash = ((hash << 5) - hash + key.charCodeAt(index)) | 0;
  }
  return hash >>> 0;
}

function pollOffset(key: string, range: number): number {
  if (browserSeed === undefined && typeof window !== "undefined") {
    const random = new Uint32Array(1);
    window.crypto.getRandomValues(random);
    browserSeed = random[0];
  }
  return (hashKey(key) + (browserSeed ?? 0)) % range;
}

export function pumpPollInterval(key: string, baseInterval = LIVE_MS): number {
  return baseInterval + pollOffset(key, 3_001);
}

function visibilityDelay(key: string): number {
  return pollOffset(key, 1_501);
}

type VisibilityRefreshOptions = {
  key: string;
  dataUpdatedAt: number;
  enabled?: boolean;
  isFetching: boolean;
  refetch: () => Promise<unknown>;
  maxAgeMs?: number;
};

export function usePumpVisibilityRefresh({
  key,
  dataUpdatedAt,
  enabled = true,
  isFetching,
  refetch,
  maxAgeMs = LIVE_MS,
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
      timer = window.setTimeout(() => void refetchRef.current(), visibilityDelay(key));
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      clearTimer();
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [enabled, key, maxAgeMs]);
}
