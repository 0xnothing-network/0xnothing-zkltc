"use client";

import { LIVE_MS, livePollInterval } from "@/lib/liveData";
import {
  jitteredPollInterval,
  useVisibilityRefresh,
  type VisibilityRefreshOptions,
} from "@/lib/pollJitter";

/** Every 0xPump trade and launch emits from the factory, so the event socket covers them. */
const SOCKET_POLL_FACTOR = 3;

export function pumpPollInterval(key: string, baseInterval = LIVE_MS): number {
  return jitteredPollInterval(key, livePollInterval(baseInterval, SOCKET_POLL_FACTOR));
}

export function usePumpVisibilityRefresh({
  maxAgeMs = LIVE_MS,
  ...options
}: Omit<VisibilityRefreshOptions, "maxAgeMs"> & { maxAgeMs?: number }): void {
  useVisibilityRefresh({ ...options, maxAgeMs });
}
