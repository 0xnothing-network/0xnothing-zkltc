import { type ReactNode, useEffect, useRef, useState } from "react";
import type { Address } from "viem";
import { t } from "../../core/i18n";
import { addHdAccount, accountLabel, renameAccount } from "../../core/keyring/vault";
import { describeError } from "../../core/lib/errors";
import { shortenAddress } from "../../core/lib/format";
import { useWallet } from "../state/WalletContext";
import { Button } from "./kit";

/**
 * The account switcher behind the header title. Sits over the current screen
 * rather than being a route of its own, so switching account never loses the
 * screen the user was on.
 */
export function AccountSheet({ onClose }: { onClose: () => void }): ReactNode {
  const { accounts, address, selectAccount, reload, notify } = useWallet();
  const [renaming, setRenaming] = useState<Address | null>(null);
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

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
    setBusy(true);
    try {
      await selectAccount(next);
      onClose();
    } catch (error) {
      notify(describeError(error), "error");
    } finally {
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
    setBusy(true);
    try {
      await renameAccount(target, trimmed.slice(0, 24));
      await reload();
      setRenaming(null);
      setLabel("");
    } catch (error) {
      notify(describeError(error), "error");
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  };

  const addAccount = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    try {
      const state = await addHdAccount();
      const created = state.accounts[state.accounts.length - 1];
      if (created) await selectAccount(created.address);
      else await reload();
      onClose();
    } catch (error) {
      notify(describeError(error), "error");
    } finally {
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
        className="w-sheet-body"
        role="dialog"
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
            ✕
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
                <span className="w-asset-symbol">{accountLabel(meta)}</span>
                <span className="w-asset-sub">
                  {shortenAddress(meta.address)}
                  {meta.source === "imported" ? t("account.imported") : ""}
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
      </div>
    </div>
  );
}
