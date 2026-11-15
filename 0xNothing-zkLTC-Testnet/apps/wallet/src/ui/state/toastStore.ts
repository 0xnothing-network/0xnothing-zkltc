/**
 * The one toast on screen, kept outside WalletContext: a toast is shown from
 * almost every screen, and as part of the context value each one re-rendered
 * every screen that reads the wallet. Only ToastBar subscribes to this store.
 * Import-free so a test can run it as it is.
 */
export type ToastTone = "info" | "ok" | "error";

export interface Toast {
  id: number;
  message: string;
  tone: ToastTone;
  /** Explorer link shown next to the message. */
  href?: string;
}

/** How long a toast stays when nothing holds it (pointer over it, focus inside it). */
export const TOAST_MS = 5_000;

let current: Toast | null = null;
let lastId = 0;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

/** Replaces any toast on screen; returns the new toast's id. */
export function showToast(message: string, tone: ToastTone = "info", href?: string): number {
  lastId += 1;
  current = { id: lastId, message, tone, href };
  emit();
  return lastId;
}

/**
 * Removes the toast. With an id, only that toast: a timer started for an older
 * toast must not take down the one that replaced it.
 */
export function dismissToast(id?: number): void {
  if (current === null || (id !== undefined && current.id !== id)) return;
  current = null;
  emit();
}

export function currentToast(): Toast | null {
  return current;
}

export function subscribeToast(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
