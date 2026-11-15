import type { Address } from "viem";
import { type DappConnection, visibleAccounts } from "../../core/services/dapp.ts";

/**
 * The site in the active tab, as the Dapp screen's first card shows it. Only the
 * origin is taken from the tab's address: never its title or anything else the
 * page writes. Only http(s) pages get the provider, so any other scheme (the new
 * tab page, chrome://, file:) has no status to show.
 */
export function siteOrigin(url: unknown): string | null {
  if (typeof url !== "string" || url.length === 0) return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

export interface CurrentSiteStatus {
  origin: string;
  connected: boolean;
  /** The granted account the site sees now: the active one, when it was granted. */
  account: Address | null;
}

/** The worker keys grants by the browser's origin string, so this is an exact match. */
export function currentSiteStatus(
  origin: string,
  connections: readonly DappConnection[],
  active: string | null | undefined,
): CurrentSiteStatus {
  const grant = connections.find((entry) => entry.origin === origin);
  if (!grant) return { origin, connected: false, account: null };
  return { origin, connected: true, account: visibleAccounts(grant.accounts, active)[0] ?? null };
}
