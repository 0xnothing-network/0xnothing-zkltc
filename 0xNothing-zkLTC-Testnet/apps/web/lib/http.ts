function responseError(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
  const value = (payload as { error?: unknown }).error;
  if (typeof value !== "string") return undefined;
  const message = value.trim();
  return message ? message.slice(0, 240) : undefined;
}

// The first read of a live data route may take the CDN's last copy, so a page paints at once.
// Every later read of the same URL is a poll or a chain-event refresh and asks for current
// data, which the route then answers without any stale-while-revalidate layer.
const LIVE_DATA_ROUTE = /^\/(?:api\/pump\/|0xFi\/api\/data\/)/;
const readLiveUrls = new Set<string>();

/** `url`, with `fresh=1` when this page has read that live data route before. */
export function liveReadUrl(url: string): string {
  if (!LIVE_DATA_ROUTE.test(url)) return url;
  if (!readLiveUrls.has(url)) {
    readLiveUrls.add(url);
    return url;
  }
  return `${url}${url.includes("?") ? "&" : "?"}fresh=1`;
}

export async function fetchJson<T>(
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
  fallbackMessage = "Request failed",
  timeoutMs = 20_000,
): Promise<T> {
  const controller = new AbortController();
  const callerSignal = init?.signal ?? (typeof Request !== "undefined" && input instanceof Request ? input.signal : undefined);
  const onAbort = () => controller.abort(callerSignal?.reason);
  if (callerSignal?.aborted) onAbort();
  else callerSignal?.addEventListener("abort", onAbort, { once: true });
  // Cover both response headers and body consumption. A stalled body otherwise
  // leaves the query fetching forever, preventing subsequent live polls.
  const timeout = setTimeout(() => controller.abort(new DOMException(
    `${fallbackMessage}: timed out`, "TimeoutError",
  )), timeoutMs);
  try {
    controller.signal.throwIfAborted();
    const url = typeof input === "string" && (init?.method ?? "GET") === "GET" ? liveReadUrl(input) : input;
    const response = await fetch(url, { ...init, signal: controller.signal });
    const payload = await response.json().catch((error: unknown) => {
      controller.signal.throwIfAborted();
      if (error instanceof SyntaxError) return undefined;
      throw error;
    }) as unknown;
    controller.signal.throwIfAborted();

    if (!response.ok) {
      throw new Error(responseError(payload) ?? `${fallbackMessage} (HTTP ${response.status})`);
    }
    if (payload === undefined) {
      throw new Error(`${fallbackMessage}: invalid JSON response`);
    }
    return payload as T;
  } finally {
    clearTimeout(timeout);
    callerSignal?.removeEventListener("abort", onAbort);
  }
}
