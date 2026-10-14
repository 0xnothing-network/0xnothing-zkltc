"use client";

import { FI_LIVE_MS, livePollInterval } from "@/lib/liveData";
import {
  jitteredPollInterval,
  useVisibilityRefresh,
  type VisibilityRefreshOptions,
} from "@/lib/pollJitter";

/** Router swaps and protocol actions emit events; liquidity on user-created pairs is only seen by polling. */
const SOCKET_POLL_FACTOR = 2;

export function fiPollInterval(key: string, baseInterval = FI_LIVE_MS): number {
  return jitteredPollInterval(key, livePollInterval(baseInterval, SOCKET_POLL_FACTOR));
}

export function useFiVisibilityRefresh({
  maxAgeMs = FI_LIVE_MS,
  ...options
}: Omit<VisibilityRefreshOptions, "maxAgeMs"> & { maxAgeMs?: number }): void {
  useVisibilityRefresh({ ...options, maxAgeMs });
}
