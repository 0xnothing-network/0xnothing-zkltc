/**
 * One time budget shared by every RPC request a load sends through one viem client.
 *
 * Each read has its own timeout, but a load runs its reads in stages, one after another.
 * When the RPC hangs, every stage waited out its own timeout and retry in turn: the pool
 * route took 27 to 33 s that way, longer than the page waits for it. With a budget the
 * request in flight is cut at the deadline and every later one fails at once, so the
 * stages fall through to their existing fallbacks together.
 */
export function createRpcBudget(budgetMs: number, fetchFn: typeof fetch = fetch) {
  // No limit until a load starts one, so a read outside any load is never refused.
  let deadline = Infinity;
  const remainingMs = () => deadline - Date.now();
  return {
    /** Opens a full budget from now. Call it where a load begins its RPC work. */
    start(): void {
      deadline = Date.now() + budgetMs;
    },
    remainingMs,
    /** The http transport's `fetchFn`. */
    fetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
      const remaining = remainingMs();
      if (remaining === Infinity) return fetchFn(input, init);
      if (remaining <= 0) return Promise.reject(new Error("RPC budget spent"));
      const cutoff = AbortSignal.timeout(remaining);
      return fetchFn(input, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, cutoff]) : cutoff });
    },
  };
}
