import { type ReactNode, useEffect, useRef, useState } from "react";
import type { Address } from "viem";
import { t } from "../../core/i18n";
import { addHdAccount, accountLabel, renameAccount } from "../../core/keyring/vault";
import { describeError } from "../../core/lib/errors";
import { shortenAddress } from "../../core/lib/format";
import {
  canOpenSidePanel,
  canOpenWalletTab,
  extensionView,
  openSidePanel,
  openWalletTab,
} from "../../core/platform/env";
import { useActionGate } from "../hooks/useActionGate";
import { useSheetFocus } from "../hooks/useSheetFocus";
import { useWallet } from "../state/WalletContext";
import { Identicon } from "./Identicon";
import { Button, Icon } from "./kit";

/**
 * The account switcher behind the header title. Sits over the current screen
 * rather than being a route of its own, so switching account never loses the
 * screen the user was on.
 */
export function AccountSheet({ onClose }: { onClose: () => void }): ReactNode {
  const { accounts, address, selectAccount, reload, notify, lockWallet } = useWallet();
  const [renaming, setRenaming] = useState<Address | null>(null);
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const sheetRef = useSheetFocus<HTMLDivElement>();
  const actionGate = useActionGate();
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Fixed for the life of the page: which surface this is never changes.
  const [panelOffered] = useState(canOpenSidePanel);
  const [tabOffered] = useState(canOpenWalletTab);
  const [windowId, setWindowId] = useState<number | null>(null);

  // The side panel opens for a window, and the click cannot wait for the lookup
  // (Chrome honours sidePanel.open only inside the gesture), so it is done here.
  useEffect(() => {
    if (!panelOffered) return undefined;
    let live = true;
    chrome.windows.getCurrent()
      .then((current) => {
        if (live && current.id !== undefined) setWindowId(current.id);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [panelOffered]);

  const toSidePanel = (): void => {
    if (busy || windowId === null) return;
    openSidePanel(windowId)
      .then(() => window.close())
      .catch(() => notify(t("account.openFailed"), "error"));
  };

  const toTab = (): void => {
    if (busy) return;
    // The popup would close as the tab takes focus anyway; the panel stays beside it.
    const fromPopup = extensionView() === "popup";
    openWalletTab()
      .then(() => {
        if (fromPopup) window.close();
      })
      .catch(() => notify(t("account.openFailed"), "error"));
  };

  // The same lock as Settings' Lock now: the session key is dropped and every
  // surface follows through the session record.
  const lockNow = async (): Promise<void> => {
    if (busy || !actionGate.tryEnter()) return;
    setBusy(true);
    try {
      await lockWallet();
    } catch (error) {
      notify(describeError(error), "error");
    } finally {
      actionGate.leave();
      if (mountedRef.current) setBusy(false);
    }
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || busy) return;
      if (renaming !== null) {
        setRenaming(null);
        setLabel("");
        return;
      }
      onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose, renaming]);

  const pick = async (next: Address): Promise<void> => {
    if (busy) return;
    if (next === address) {
      onClose();
      return;
    }
    if (!actionGate.tryEnter()) return;
    setBusy(true);
    try {
      await selectAccount(next);
      onClose();
    } catch (error) {
      notify(describeError(error), "error");
    } finally {
      actionGate.leave();
      if (mountedRef.current) setBusy(false);
    }
  };

  const saveLabel = async (target: Address): Promise<void> => {
    if (busy) return;
    const trimmed = label.trim();
    if (trimmed.length === 0) {
      setRenaming(null);
      return;
    }
    if (!actionGate.tryEnter()) return;
    setBusy(true);
    try {
      await renameAccount(target, trimmed.slice(0, 24));
      await reload();
      setRenaming(null);
      setLabel("");
    } catch (error) {
      notify(describeError(error), "error");
    } finally {
      actionGate.leave();
      if (mountedRef.current) setBusy(false);
    }
  };

  const addAccount = async (): Promise<void> => {
    if (busy || !actionGate.tryEnter()) return;
    setBusy(true);
    try {
      const state = await addHdAccount();
      // addHdAccount makes the new account active; select that one, not the
      // last row, which can be an imported key when nothing was added.
      if (state.active) await selectAccount(state.active);
      else await reload();
      onClose();
    } catch (error) {
      notify(describeError(error), "error");
    } finally {
      actionGate.leave();
      if (mountedRef.current) setBusy(false);
    }
  };

  return (
    <div
      className="w-sheet"
      onClick={() => {
        if (!busy) onClose();
      }}
    >
      <div
        ref={sheetRef}
        className="w-sheet-body w-account-sheet"
        role="dialog"
        tabIndex={-1}
        aria-modal="true"
        aria-label={t("account.title")}
        aria-busy={busy}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="w-sheet-head">
          <span>{t("account.title")}</span>
          <button
            type="button"
            className="w-back"
            disabled={busy}
            onClick={onClose}
            aria-label={t("common.close")}
          >
            <Icon name="close" size={16} />
          </button>
        </header>

        {accounts.map((meta) => (
          <div key={meta.address}>
            <div className="w-account" aria-current={meta.address === address}>
              <button
                type="button"
                className="w-account-main"
                disabled={busy}
                aria-pressed={meta.address === address}
                autoFocus={meta.address === address}
                onClick={() => void pick(meta.address)}
              >
                {/* The same picture the home header leads with. */}
                <span className="w-avatar" aria-hidden="true">
                  <Identicon address={meta.address} size={24} />
                </span>
                <span className="w-account-text">
                  <span className="w-asset-symbol">{accountLabel(meta)}</span>
                  <span className="w-asset-sub">
                    {shortenAddress(meta.address)}
                    {meta.source === "imported" ? t("account.imported") : ""}
                  </span>
                </span>
              </button>
              <Button
                size="sm"
                disabled={busy}
                onClick={() => {
                  const opening = renaming !== meta.address;
                  setRenaming(opening ? meta.address : null);
                  // Only a name the user chose is worth editing: a generated
                  // default would otherwise be saved and stop following the
                  // interface language.
                  const stored = meta.label.trim();
                  setLabel(opening && stored === accountLabel(meta) ? stored : "");
                }}
              >
                {t("common.rename")}
              </Button>
            </div>
            {renaming === meta.address ? (
              <div className="w-panel-body">
                <input
                  className="w-input"
                  value={label}
                  maxLength={24}
                  disabled={busy}
                  autoFocus
                  aria-label={t("account.namePlaceholder")}
                  onChange={(event) => setLabel(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      void saveLabel(meta.address);
                    }
                  }}
                />
                <div className="w-btn-row">
                  <Button size="sm" disabled={busy} onClick={() => setRenaming(null)}>
                    {t("common.cancel")}
                  </Button>
                  <Button
                    size="sm"
                    variant="primary"
                    disabled={busy}
                    onClick={() => void saveLabel(meta.address)}
                  >
                    {t("common.save")}
                  </Button>
                </div>
              </div>
            ) : null}
          </div>
        ))}

        <div className="w-panel-body">
          <Button block disabled={busy} onClick={() => void addAccount()}>
            {t("account.add")}
          </Button>
        </div>

        {/* Quiet text actions at the foot: where the wallet lives (extension only) and Lock now. */}
        <div className="w-account-actions">
          {panelOffered ? (
            <Button
              size="sm"
              variant="ghost"
              disabled={busy || windowId === null}
              onClick={toSidePanel}
            >
              {t("account.sidePanel")}
            </Button>
          ) : null}
          {tabOffered ? (
            <Button size="sm" variant="ghost" disabled={busy} onClick={toTab}>
              {t("account.openTab")}
              <Icon name="external" size={14} />
            </Button>
          ) : null}
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => void lockNow()}>
            {t("set.lockNow")}
          </Button>
        </div>
      </div>
    </div>
  );
}
