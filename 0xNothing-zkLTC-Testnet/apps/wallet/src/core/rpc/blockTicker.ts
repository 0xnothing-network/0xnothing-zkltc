import { activeNetwork, publicClient } from "./client";

/**
 * One shared block poller for the whole UI.
 *
 * Screens do not refresh themselves and there is no reload button anywhere: a
 * single `eth_blockNumber` every few seconds is the wallet's clock, and every
 * live read re-runs when the height moves. One poller means one request per
 * tick no matter how many panels are mounted, and nothing at all while the
 * document is hidden — a popup that is closed must not keep talking to the RPC.
 */
type Listener = (blockNumber: bigint) => void;

const POLL_MS = 3_000;
const MAX_POLL_MS = 30_000;
const JITTER = 0.1;

const listeners = new Set<Listener>();
let timer: ReturnType<typeof setTimeout> | undefined;
let latest = 0n;
let inFlight = false;
let running = false;
let failures = 0;
let networkKey = activeNetwork.id;

function hidden(): boolean {
  return typeof document !== "undefined" && document.hidden;
}

function clearTimer(): void {
  if (timer === undefined) return;
  clearTimeout(timer);
  timer = undefined;
}

function nextDelay(): number {
  const backoff = Math.min(MAX_POLL_MS, POLL_MS * 2 ** Math.min(failures, 4));
  const jittered = Math.round(backoff * (1 - JITTER + Math.random() * JITTER * 2));
  return Math.min(MAX_POLL_MS, jittered);
}

function schedule(): void {
  if (!running || listeners.size === 0 || hidden() || inFlight || timer !== undefined) return;
  timer = setTimeout(() => {
    timer = undefined;
    void poll();
  }, nextDelay());
}

async function poll(): Promise<void> {
  if (!running || listeners.size === 0 || inFlight || hidden()) return;
  if (networkKey !== activeNetwork.id) {
    networkKey = activeNetwork.id;
    latest = 0n;
    failures = 0;
  }
  inFlight = true;
  try {
    const next = await publicClient.getBlockNumber({ cacheTime: 0 });
    failures = 0;
    if (next > latest) {
      latest = next;
      for (const listener of listeners) {
        try {
          listener(next);
        } catch {
          // One screen's callback must not prevent the remaining reads from
          // receiving the new block height.
        }
      }
    }
  } catch {
    // Offline or throttled. Back off rather than amplifying pressure on the
    // endpoint, then return to the foreground cadence after a success.
    failures = Math.min(failures + 1, 4);
  } finally {
    inFlight = false;
    schedule();
  }
}

/** The last height seen, or 0n before the first poll returns. */
export function latestBlock(): bigint {
  if (networkKey !== activeNetwork.id) {
    networkKey = activeNetwork.id;
    latest = 0n;
    failures = 0;
  }
  return latest;
}

function onVisible(): void {
  clearTimer();
  if (document.hidden) return;
  failures = 0;
  void poll();
}

export function subscribeBlocks(listener: Listener): () => void {
  listeners.add(listener);
  if (!running) {
    running = true;
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", onVisible);
    }
    void poll();
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && running) {
      running = false;
      clearTimer();
      failures = 0;
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", onVisible);
      }
    }
  };
}
