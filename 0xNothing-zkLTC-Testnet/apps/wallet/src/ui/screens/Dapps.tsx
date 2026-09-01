import { type ReactNode, useEffect, useState } from "react";
import { DAPPS } from "../../config/dapps";
import { t } from "../../core/i18n";
import { describeError } from "../../core/lib/errors";
import { formatTimeAgo, shortenAddress } from "../../core/lib/format";
import { isExtension, openExternal } from "../../core/platform/env";
import { persistentStore } from "../../core/platform/storage";
import { STORAGE_KEYS } from "../../core/platform/storageKeys";
import { listConnections, revokeConnection } from "../../core/services/dapp";
import { announceToPages } from "../../core/services/walletEvents";
import { Button, Note, Panel, PanelBody } from "../components/kit";
import { Screen } from "../components/Screen";
import { useActionGate } from "../hooks/useActionGate";
import { useLiveRead } from "../hooks/useLiveRead";
import { useWallet } from "../state/WalletContext";

/**
 * DAPP. A launcher plus the list of origins that may ask this wallet to sign.
 *
 * On the extension the opened pages get the injected provider and connect like
 * any other site. On Android the links go to the system browser, where the site
 * uses its own connectors — a cross-origin WebView cannot receive an injected
 * provider, so the screen says so instead of leaving the user waiting for a
 * prompt that will never come.
 */
export function Dapps(): ReactNode {
  const { tick } = useWallet();
  const read = useLiveRead(() => listConnections(), [tick], {
    live: false,
    identity: [],
  });
  const [busy, setBusy] = useState<string | null>(null);
  const actionGate = useActionGate();
  const [actionError, setActionError] = useState<string | null>(null);
  const connections = read.data ?? [];

  // Grants and revocations are often written by a different surface (the
  // approval popup or another wallet window), so a local React tick is not
  // enough to keep this list current.
  useEffect(() => persistentStore.subscribe(
    STORAGE_KEYS.connections,
    () => read.reload(),
  ), [read.reload]);

  const revoke = async (origin: string): Promise<void> => {
    if (busy !== null || !actionGate.tryEnter()) return;
    setBusy(origin);
    setActionError(null);
    try {
      await revokeConnection(origin);
      await announceToPages("accountsChanged", [], [origin]);
      read.reload();
    } catch (cause) {
      setActionError(describeError(cause));
    } finally {
      actionGate.leave();
      setBusy(null);
    }
  };
  return (
    <Screen title={t("dapp.title")}>
      <div className="w-list">
        {DAPPS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            className="w-dapp"
            onClick={() => void openExternal(entry.url)}
          >
            <span className="w-mark" aria-hidden="true">
              {entry.mark}
            </span>
            <span className="w-asset-main">
              <span className="w-asset-symbol">{entry.title}</span>
              <span className="w-asset-sub">{entry.subtitle}</span>
            </span>
            <span className="w-asset-side">
              <span className="w-asset-usd" aria-hidden="true">↗</span>
            </span>
          </button>
        ))}
      </div>
      <div className="w-stack" aria-busy={read.busy || busy !== null}>
        <Panel title={t("dapp.connections")}>
          <PanelBody>
            {read.loading && read.data === null ? (
              <Note>{t("common.working")}</Note>
            ) : read.error !== null && read.data === null ? (
              <div role="alert">
                <Note tone="error">{read.error}</Note>
              </div>
            ) : connections.length === 0 ? (
              <Note>{isExtension ? t("dapp.emptyExt") : t("dapp.emptyAndroid")}</Note>
            ) : (
              connections.map((entry) => (
                <div key={entry.origin} className="w-split">
                  <span className="w-asset-main">
                    <span className="w-asset-symbol">{entry.origin}</span>
                    <span className="w-asset-sub">
                      {entry.accounts.map((account) => shortenAddress(account)).join(", ")} ·{" "}
                      {formatTimeAgo(entry.at)}
                    </span>
                  </span>
                  <Button
                    size="sm"
                    variant="danger"
                    disabled={busy !== null}
                    onClick={() => void revoke(entry.origin)}
                  >
                    {busy === entry.origin ? t("common.working") : t("dapp.revoke")}
                  </Button>
                </div>
              ))
            )}
            {read.error !== null && read.data !== null ? (
              <div role="alert">
                <Note tone="error">{read.error}</Note>
              </div>
            ) : null}
          </PanelBody>
        </Panel>
        {actionError !== null ? (
          <div role="alert">
            <Note tone="error">{actionError}</Note>
          </div>
        ) : null}
        <Note>{t("dapp.note")}</Note>
      </div>
    </Screen>
  );
}
