import { type ReactNode, useEffect, useState } from "react";
import { DAPPS } from "../../config/dapps";
import { t } from "../../core/i18n";
import { accountLabel } from "../../core/keyring/vault";
import { describeError } from "../../core/lib/errors";
import { formatTimeAgo, shortenAddress } from "../../core/lib/format";
import { extensionView, isExtension, openExternal } from "../../core/platform/env";
import { persistentStore } from "../../core/platform/storage";
import { STORAGE_KEYS } from "../../core/platform/storageKeys";
import { listConnections, revokeConnection } from "../../core/services/dapp";
import { announceToPages } from "../../core/services/walletEvents";
import { Button, Icon, Note } from "../components/kit";
import { Screen } from "../components/Screen";
import { useActionGate } from "../hooks/useActionGate";
import { currentSiteStatus, siteOrigin } from "../lib/currentSite";
import { useLiveRead } from "../hooks/useLiveRead";
import { navigate } from "../router";
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
  const { accounts, address, tick } = useWallet();
  const read = useLiveRead(() => listConnections(), [tick], {
    live: false,
    identity: [],
  });
  const [busy, setBusy] = useState<string | null>(null);
  const actionGate = useActionGate();
  const [actionError, setActionError] = useState<string | null>(null);
  const connections = read.data ?? [];
  // The active tab's address is readable only in the popup, where the toolbar
  // click or the shortcut granted activeTab; the side panel, a wallet tab and
  // Android show no site status at all rather than a guess.
  const [tabUrl, setTabUrl] = useState<string | undefined>(undefined);
  useEffect(() => {
    if (extensionView() !== "popup" || typeof chrome.tabs?.query !== "function") return undefined;
    let live = true;
    chrome.tabs.query({ active: true, currentWindow: true })
      .then(([tab]) => {
        if (live) setTabUrl(tab?.url);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);
  const tabOrigin = siteOrigin(tabUrl);
  const site = tabOrigin !== null && read.data !== null
    ? currentSiteStatus(tabOrigin, read.data, address)
    : null;
  // Each site keeps the accounts it was granted (up to 8) and sees only the
  // active one among them: list every one, by name where the wallet has it.
  const grantedName = (account: string): string | null => {
    const meta = accounts.find((entry) => entry.address.toLowerCase() === account.toLowerCase());
    return meta ? accountLabel(meta) : null;
  };

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
      await announceToPages("accountsChanged");
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
      <div className="w-stack w-dapps" aria-busy={read.busy || busy !== null}>
        {site !== null ? (
          <section className="w-dapp-sites w-dapp-current">
            <h2 className="w-dapp-sites-label">{t("dapp.currentSite")}</h2>
            <div className="w-split w-dapp-site">
              <span className="w-asset-main">
                <span className="w-asset-symbol">{site.origin}</span>
                <span className="w-asset-sub" title={site.account ?? undefined}>
                  {!site.connected
                    ? t("dapp.siteNotConnected")
                    : site.account === null
                      ? t("dapp.siteInactive")
                      : `${t("dapp.siteConnected")} · ${
                        grantedName(site.account) !== null ? `${grantedName(site.account)} · ` : ""
                      }${shortenAddress(site.account)}`}
                </span>
              </span>
              {site.connected ? (
                <Button
                  size="sm"
                  disabled={busy !== null}
                  onClick={() => void revoke(site.origin)}
                >
                  {busy === site.origin ? t("common.working") : t("dapp.revoke")}
                </Button>
              ) : null}
            </div>
          </section>
        ) : null}
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
                <span className="w-asset-usd" aria-hidden="true"><Icon name="external" size={16} /></span>
              </span>
            </button>
          ))}
        </div>
        {/* Connected sites: the label outside, each origin on its own small card. */}
        <section className="w-dapp-sites">
          <h2 className="w-dapp-sites-label">{t("dapp.connections")}</h2>
          {read.loading && read.data === null ? (
            <div className="w-dapp-site">
              <Note>{t("common.working")}</Note>
            </div>
          ) : read.error !== null && read.data === null ? (
            <div role="alert">
              <Note tone="error">{read.error}</Note>
            </div>
          ) : connections.length === 0 ? (
            <div className="w-dapp-site">
              <Note>{isExtension ? t("dapp.emptyExt") : t("dapp.emptyAndroid")}</Note>
            </div>
          ) : (
            connections.map((entry) => (
              <div key={entry.origin} className="w-split w-dapp-site">
                <span className="w-asset-main">
                  <span className="w-asset-symbol">{entry.origin}</span>
                  <span className="w-asset-sub">{t("dapp.grantedAccounts")}</span>
                  {entry.accounts.map((account) => {
                    const name = grantedName(account);
                    return (
                      <span key={account} className="w-asset-sub w-dapp-account" title={account}>
                        {name !== null ? `${name} · ` : ""}{shortenAddress(account)}
                      </span>
                    );
                  })}
                  <span className="w-asset-sub">{formatTimeAgo(entry.at)}</span>
                </span>
                <Button
                  size="sm"
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
        </section>
        {isExtension ? (
          <Button size="sm" variant="ghost" onClick={() => navigate("settings?panel=approvals")}>
            {t("dapp.approvalsLink")}
          </Button>
        ) : null}
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
