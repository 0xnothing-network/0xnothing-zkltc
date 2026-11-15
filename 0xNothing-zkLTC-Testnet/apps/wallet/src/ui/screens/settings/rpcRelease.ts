import { LITVM_RPC_URL } from "../../../config/chain";
import { litvmRpcOverride } from "../../../config/networks";
import { readSettings } from "../../../core/keyring/vault";
import { isExtension } from "../../../core/platform/env";
import { rpcPermissionPattern } from "../../lib/rpcPermission";

/** The one call of chrome.permissions this needs, so a test can stand in for it. */
export interface PermissionRemover {
  remove(request: { origins: string[] }): Promise<boolean>;
}

/** The extension's permissions API, or undefined on Android and the web. */
function extensionRemover(): PermissionRemover | undefined {
  if (!isExtension || typeof chrome === "undefined" || !chrome.permissions?.remove) return undefined;
  return chrome.permissions;
}

export async function releaseRpcPermission(
  rpcUrl: string,
  permissions: PermissionRemover | undefined = extensionRemover(),
): Promise<void> {
  if (permissions === undefined) return;
  try {
    const pattern = rpcPermissionPattern(rpcUrl);
    if (pattern !== null) await permissions.remove({ origins: [pattern] });
  } catch {
    // The profile has already been removed. Permission cleanup is best-effort
    // and must not make the saved settings appear to have failed.
  }
}

/**
 * Drops the host grant of `rpcUrl` unless a saved network, or the user's own
 * LiteForge RPC, still uses the same host. The saved list is read again here, not taken from a screen's copy: the
 * Settings form and a dapp's proposal in the approval window both add networks.
 * A settings read that fails keeps the grant (a kept grant is harmless; a
 * dropped one breaks a saved network).
 */
export async function releaseRpcPermissionUnlessUsed(
  rpcUrl: string,
  permissions: PermissionRemover | undefined = extensionRemover(),
  read: typeof readSettings = readSettings,
): Promise<void> {
  if (permissions === undefined) return;
  const pattern = rpcPermissionPattern(rpcUrl);
  // The public LiteForge host is a manifest permission: never asked, never dropped.
  if (pattern === null || pattern === rpcPermissionPattern(LITVM_RPC_URL)) return;
  let used: boolean;
  try {
    const settings = await read();
    const override = litvmRpcOverride(settings.litvmRpcUrl);
    used = settings.customNetworks.some((network) => rpcPermissionPattern(network.rpcUrl) === pattern)
      || (override !== null && rpcPermissionPattern(override) === pattern);
  } catch {
    return;
  }
  if (!used) await releaseRpcPermission(rpcUrl, permissions);
}

/**
 * Run before an erase: the erase drops every custom RPC profile and the user's
 * LiteForge RPC, and nothing
 * would ever release the host grants made for them, so the extension would keep
 * network access to the old providers. A grant Chrome refuses to drop (a host
 * the manifest requires) or a settings read that fails is passed over: the
 * erase itself must never fail on this.
 */
export async function releaseCustomRpcPermissions(
  permissions: PermissionRemover | undefined = extensionRemover(),
): Promise<void> {
  if (permissions === undefined) return;
  let rpcUrls: string[];
  try {
    const settings = await readSettings();
    const override = litvmRpcOverride(settings.litvmRpcUrl);
    rpcUrls = [
      ...settings.customNetworks.map((network) => network.rpcUrl),
      ...(override === null ? [] : [override]),
    ];
  } catch {
    return;
  }
  await Promise.all(rpcUrls.map((rpcUrl) => releaseRpcPermission(rpcUrl, permissions)));
}

/** What the erase needs from chrome.permissions and chrome.notifications, so a test can stand in. */
export interface NotificationRelease {
  permissions: { remove(request: { permissions: "notifications"[] }): Promise<boolean> };
  /** Absent while the optional permission is not held. */
  notifications?: { getAll(): Promise<object>; clear(id: string): Promise<boolean> };
}

function extensionNotificationRelease(): NotificationRelease | undefined {
  if (!isExtension || typeof chrome === "undefined" || !chrome.permissions?.remove) return undefined;
  return { permissions: chrome.permissions, notifications: chrome.notifications };
}

/**
 * Run before an erase, like the RPC grants: the notifications permission is
 * given back (switching notifications Off does the same), and the summaries
 * already shown leave the system's notification centre. Cleared first, while the
 * API is still there. Never throws.
 */
export async function releaseNotificationsBeforeErase(
  api: NotificationRelease | undefined = extensionNotificationRelease(),
): Promise<void> {
  if (api === undefined) return;
  try {
    const shown = await api.notifications?.getAll();
    if (shown) await Promise.all(Object.keys(shown).map((id) => api.notifications?.clear(id).catch(() => false)));
  } catch {
    // Nothing shown, or the API went with the permission: nothing to clear.
  }
  await api.permissions.remove({ permissions: ["notifications"] }).catch(() => false);
}
