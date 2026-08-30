import { hasChromeStorage } from "../platform/env";

/**
 * Provider events that originate in the wallet UI rather than in a page.
 *
 * Switching account or locking the wallet has to reach every connected tab, but
 * only the service worker can talk to content scripts — so the UI asks it to fan
 * the event out. Outside the extension there are no injected pages and the call
 * is a no-op.
 */
export async function announceToPages(name: string, data: unknown, origins?: readonly string[]): Promise<void> {
  if (!hasChromeStorage || !chrome?.runtime?.sendMessage) return;
  try {
    await chrome.runtime.sendMessage({ kind: "wallet-event", name, data, origins });
  } catch {
    // No worker listening (it was just replaced); the page re-reads on its next
    // eth_accounts call, so there is nothing to recover here.
  }
}
