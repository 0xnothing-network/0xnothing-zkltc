import { type ReactNode, useEffect, useState } from "react";
import { t } from "../../core/i18n";
import { isExtension } from "../../core/platform/env";
import { rpcAccessMissing, rpcHost, rpcPermissionPattern } from "../lib/rpcPermission";
import { Button, Note } from "./kit";

/** The extension's permissions API, or undefined on Android and the web. */
export function extensionPermissions(): typeof chrome.permissions | undefined {
  if (!isExtension || typeof chrome === "undefined" || !chrome.permissions?.contains) return undefined;
  return chrome.permissions;
}

/**
 * Asks Chrome for the RPC host. Call it straight from a click handler: Chrome
 * only shows the prompt inside a user gesture.
 */
export async function requestRpcPermission(rpcUrl: string): Promise<boolean> {
  if (!isExtension || typeof chrome === "undefined" || !chrome.permissions?.request) return true;
  try {
    const pattern = rpcPermissionPattern(rpcUrl);
    return pattern !== null && await chrome.permissions.request({ origins: [pattern] });
  } catch {
    return false;
  }
}

/**
 * The selected RPC host is not granted to the extension (a saved local node
 * after loopback moved to optional permissions, or a grant removed in Chrome's
 * settings): say so and offer the grant. Nothing renders off the extension.
 */
export function RpcAccessPrompt({ rpcUrl }: { rpcUrl: string }): ReactNode {
  const [missing, setMissing] = useState(false);
  const [asking, setAsking] = useState(false);

  useEffect(() => {
    const permissions = extensionPermissions();
    if (permissions === undefined) return undefined;
    let live = true;
    const check = (): void => {
      void rpcAccessMissing(rpcUrl, permissions).then((value) => {
        if (live) setMissing(value);
      });
    };
    check();
    // A grant or removal from Chrome's own settings page lands here too.
    permissions.onAdded?.addListener(check);
    permissions.onRemoved?.addListener(check);
    return () => {
      live = false;
      permissions.onAdded?.removeListener(check);
      permissions.onRemoved?.removeListener(check);
    };
  }, [rpcUrl]);

  if (!missing) return null;

  const allow = (): void => {
    if (asking) return;
    setAsking(true);
    // Called in the click itself: Chrome shows the prompt only inside a gesture.
    void requestRpcPermission(rpcUrl)
      .then((granted) => {
        if (granted) setMissing(false);
      })
      .finally(() => setAsking(false));
  };

  return (
    <div className="w-stack" role="status">
      <Note tone="warn">{t("set.rpcAccessNeeded", { host: rpcHost(rpcUrl) })}</Note>
      <Button size="sm" disabled={asking} onClick={allow}>{t("set.rpcAccessAllow")}</Button>
    </div>
  );
}
