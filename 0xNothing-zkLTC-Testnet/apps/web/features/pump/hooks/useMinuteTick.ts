"use client";

import { useSyncExternalStore } from "react";

// One shared clock for every relative-age label ("Just now", "3m ago"). Those
// labels read Date.now() but sit behind memo() on data fields, so a quiet
// market froze its age at whatever it said when the page loaded.
const listeners = new Set<() => void>();
let minute = Math.floor(Date.now() / 60_000);
let timer: number | undefined;

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (timer === undefined) {
    minute = Math.floor(Date.now() / 60_000);
    timer = window.setInterval(() => {
      const next = Math.floor(Date.now() / 60_000);
      if (next === minute) return;
      minute = next;
      for (const notify of [...listeners]) notify();
    }, 15_000);
  }
  return () => {
    listeners.delete(listener);
    if (!listeners.size && timer !== undefined) {
      window.clearInterval(timer);
      timer = undefined;
    }
  };
}

function getSnapshot() {
  return minute;
}

function getServerSnapshot() {
  return 0;
}

/** Re-renders the caller once per wall-clock minute, so relative ages keep moving. */
export function useMinuteTick(): number {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
