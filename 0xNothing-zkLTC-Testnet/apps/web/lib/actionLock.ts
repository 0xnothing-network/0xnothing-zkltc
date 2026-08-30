export interface ActionLock {
  current: boolean;
}

export function tryAcquireAction(lock: ActionLock): boolean {
  if (lock.current) return false;
  lock.current = true;
  return true;
}

export function releaseAction(lock: ActionLock): void {
  lock.current = false;
}
