"use client";

import { useEffect, useRef } from "react";
import { FI_LIVE_MS } from "@/lib/liveData";

let browserSeed: number | undefined;

function hashKey(key: string): number {
  let hash = 0;
  for (let index = 0; index < key.length; index += 1) {
    hash = ((hash << 5) - hash + key.charCodeAt(index)) | 0;
  }
  return hash >>> 0;
}

export function fiPollInterval(key: string, baseInterval = FI_LIVE_MS): number {
  return baseInterval + (pollOffset(key, 3_001));
}

function fiVisibilityRefreshDelay(key: string): number {
  return pollOffset(key, 1_501);
}

function pollOffset(key: string, range: number): number {
  if (browserSeed === undefined && typeof window !== "undefined") {
    const random = new Uint32Array(1);
    window.crypto.getRandomValues(random);
    browserSeed = random[0];
  }
  return (hashKey(key) + (browserSeed ?? 0)) % range;
}

type VisibilityRefreshOptions = {
  key: string;
  dataUpdatedAt: number;
  isFetching: boolean;
  refetch: () => Promise<unknown>;
  maxAgeMs?: number;
};

export function useFiVisibilityRefresh({
  key,
  dataUpdatedAt,
  isFetching,
  refetch,
  maxAgeMs = FI_LIVE_MS,
}: VisibilityRefreshOptions): void {
  const refetchRef = useRef(refetch);
  const dataUpdatedAtRef = useRef(dataUpdatedAt);
  const isFetchingRef = useRef(isFetching);

  useEffect(() => {
    refetchRef.current = refetch;
    dataUpdatedAtRef.current = dataUpdatedAt;
    isFetchingRef.current = isFetching;
  }, [dataUpdatedAt, isFetching, refetch]);

  useEffect(() => {
    let timer: number | undefined;
    const clearTimer = () => {
      if (timer !== undefined) window.clearTimeout(timer);
      timer = undefined;
    };
    const onVisibilityChange = () => {
      clearTimer();
      if (document.visibilityState !== "visible" || isFetchingRef.current) return;
      if (Date.now() - dataUpdatedAtRef.current < maxAgeMs) return;
      timer = window.setTimeout(() => void refetchRef.current(), fiVisibilityRefreshDelay(key));
    };

    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      clearTimer();
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [key, maxAgeMs]);
}
