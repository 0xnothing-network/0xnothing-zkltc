"use client";

import { FI_LIVE_MS } from "@/lib/liveData";
import {
  jitteredPollInterval,
  useVisibilityRefresh,
  type VisibilityRefreshOptions,
} from "@/lib/pollJitter";

export function fiPollInterval(key: string, baseInterval = FI_LIVE_MS): number {
  return jitteredPollInterval(key, baseInterval);
}

export function useFiVisibilityRefresh({
  maxAgeMs = FI_LIVE_MS,
  ...options
}: Omit<VisibilityRefreshOptions, "maxAgeMs"> & { maxAgeMs?: number }): void {
  useVisibilityRefresh({ ...options, maxAgeMs });
}
