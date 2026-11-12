export interface RpcIngressGate {
  tryAcquire(origin: string): (() => void) | null;
  active(): { global: number; origins: number };
}

export function createRpcIngressGate(options: {
  maxGlobal: number;
  maxPerOrigin: number;
}): RpcIngressGate {
  const { maxGlobal, maxPerOrigin } = options;
  if (!Number.isSafeInteger(maxGlobal) || maxGlobal <= 0) {
    throw new Error("maxGlobal must be a positive safe integer");
  }
  if (!Number.isSafeInteger(maxPerOrigin) || maxPerOrigin <= 0 || maxPerOrigin > maxGlobal) {
    throw new Error("maxPerOrigin must be a positive safe integer no greater than maxGlobal");
  }

  const perOrigin = new Map<string, number>();
  let global = 0;

  function tryAcquire(origin: string): (() => void) | null {
    const originCount = perOrigin.get(origin) ?? 0;
    if (global >= maxGlobal || originCount >= maxPerOrigin) return null;
    global += 1;
    perOrigin.set(origin, originCount + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      global = Math.max(0, global - 1);
      const remaining = (perOrigin.get(origin) ?? 1) - 1;
      if (remaining <= 0) perOrigin.delete(origin);
      else perOrigin.set(origin, remaining);
    };
  }

  return {
    tryAcquire,
    active: () => ({ global, origins: perOrigin.size }),
  };
}

export interface RpcSlotQueue {
  /** Resolves true once a slot is held, or false at once when the waiting line is full. */
  acquire(): Promise<boolean>;
  release(): void;
}

/** A fixed number of slots with a bounded first-come line behind them. */
export function createRpcSlotQueue(options: { maxInFlight: number; maxWaiting: number }): RpcSlotQueue {
  const { maxInFlight, maxWaiting } = options;
  if (!Number.isSafeInteger(maxInFlight) || maxInFlight <= 0) {
    throw new Error("maxInFlight must be a positive safe integer");
  }
  if (!Number.isSafeInteger(maxWaiting) || maxWaiting < 0) {
    throw new Error("maxWaiting must be a non-negative safe integer");
  }
  let inFlight = 0;
  const waiters: Array<() => void> = [];

  return {
    async acquire() {
      if (inFlight < maxInFlight) {
        inFlight += 1;
        return true;
      }
      if (waiters.length >= maxWaiting) return false;
      await new Promise<void>((resolve) => waiters.push(resolve));
      return true;
    },
    release() {
      const next = waiters.shift();
      if (next) {
        // Ownership transfers directly; keeping the count unchanged prevents a
        // request arriving in this microtask gap from exceeding the concurrency cap.
        next();
        return;
      }
      inFlight = Math.max(0, inFlight - 1);
    },
  };
}
