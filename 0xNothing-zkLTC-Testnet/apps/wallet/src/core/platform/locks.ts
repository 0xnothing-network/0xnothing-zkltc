/**
 * Serialises mutations that may originate in different extension documents.
 * Web Locks cover the popup, approval window and service worker together; the
 * in-process queue keeps tests and older WebViews correct within one context.
 */
const localTails = new Map<string, Promise<void>>();

function lockManager(): LockManager | null {
  if (typeof navigator === "undefined") return null;
  return navigator.locks ?? null;
}

async function withLocalLock<T>(name: string, task: () => Promise<T>): Promise<T> {
  const previous = localTails.get(name) ?? Promise.resolve();
  let release!: () => void;
  const turn = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => turn);
  localTails.set(name, tail);
  await previous;
  try {
    return await task();
  } finally {
    release();
    if (localTails.get(name) === tail) localTails.delete(name);
  }
}

export function withNamedLock<T>(name: string, task: () => Promise<T>): Promise<T> {
  const manager = lockManager();
  if (!manager) return withLocalLock(name, task);
  return manager.request(`0xnothing:${name}`, { mode: "exclusive" }, () => task()).then((result) => result);
}
