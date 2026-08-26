"use client";

import { LIVE_MS } from "@/lib/liveData";
import {
  jitteredPollInterval,
  useVisibilityRefresh,
  type VisibilityRefreshOptions,
} from "@/lib/pollJitter";

export function pumpPollInterval(key: string, baseInterval = LIVE_MS): number {
  return jitteredPollInterval(key, baseInterval);
}

export function usePumpVisibilityRefresh({
  maxAgeMs = LIVE_MS,
  ...options
}: Omit<VisibilityRefreshOptions, "maxAgeMs"> & { maxAgeMs?: number }): void {
  useVisibilityRefresh({ ...options, maxAgeMs });
}
