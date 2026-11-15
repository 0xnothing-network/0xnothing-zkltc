import { hasChromeStorage } from "../platform/env";

/**
 * Provider events that originate in the wallet UI rather than in a page.
 *
 * Switching account or network, or revoking a site, has to reach the open tabs, but
 * only the service worker can talk to content scripts — so the UI asks it to ping
 * them. Only the event's name is sent: each page then asks the worker for its own
 * accounts and chain, so nothing here decides what a site may see. Outside the
 * extension there are no injected pages and the call is a no-op.
 */
export async function announceToPages(name: "accountsChanged" | "chainChanged"): Promise<void> {
  if (!hasChromeStorage || !chrome?.runtime?.sendMessage) return;
  try {
    await chrome.runtime.sendMessage({ kind: "wallet-event", name });
  } catch {
    // No worker listening (it was just replaced); the page re-reads on its next
    // eth_accounts call, so there is nothing to recover here.
  }
}

/**
 * Whether the service worker still waits for dapp request `id`. A worker that
 * died (a crash, a kill) dropped the page's channel and the page was told 4900;
 * its row stays in storage, and approving it would sign or send for no one. The
 * message also wakes such a worker, whose startup sweep answers the old rows.
 *
 * Only the real answer counts: a failed message reads as not live, which turns
 * the request away as expired (safe). Outside the extension there is no worker
 * and no dapp queue, so nothing is asked.
 */
export async function workerAwaits(id: string): Promise<boolean> {
  if (!hasChromeStorage || !chrome?.runtime?.sendMessage) return true;
  try {
    const reply = await chrome.runtime.sendMessage({ kind: "approval-live", id }) as { live?: unknown } | undefined;
    return reply?.live === true;
  } catch {
    return false;
  }
}
