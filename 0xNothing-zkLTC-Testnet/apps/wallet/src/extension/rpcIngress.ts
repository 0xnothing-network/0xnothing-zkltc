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
