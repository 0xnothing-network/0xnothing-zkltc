import { type ReactNode, useState } from "react";
import { type Hex, isHex } from "viem";
import { t } from "../../../core/i18n";
import { importPrivateKey } from "../../../core/keyring/vault";
import { describeError } from "../../../core/lib/errors";
import { Button, Note, Panel, PanelBody } from "../../components/kit";
import { useActionGate } from "../../hooks/useActionGate";
import { useWallet } from "../../state/WalletContext";

/**
 * Importing a raw private key. It rewrites the vault blob, so the password is
 * required here even while unlocked — and the field is cleared the moment the
 * import returns, whether it succeeded or not.
 *
 * Adding a normal account needs no key and no password; that lives in the
 * account sheet behind the header title.
 */
const KEY_LENGTH = 66;

export function ImportAccount(): ReactNode {
  const { reload, selectAccount, notify } = useWallet();
  const [open, setOpen] = useState(false);
  const [key, setKey] = useState("");
  const [password, setPassword] = useState("");
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const actionGate = useActionGate();
  const [error, setError] = useState<string | null>(null);

  const trimmed = key.trim();
  const valid = isHex(trimmed) && trimmed.length === KEY_LENGTH;
  const ready = valid && password.length > 0;

  const close = (): void => {
    setOpen(false);
    setKey("");
    setPassword("");
    setLabel("");
    setError(null);
  };

  const submit = async (): Promise<void> => {
    if (busy || !ready || !actionGate.tryEnter()) return;
    setBusy(true);
    setError(null);
    try {
      const state = await importPrivateKey(password, trimmed as Hex, label.trim() || undefined);
      setKey("");
      setPassword("");
      await reload();
      if (state.active) await selectAccount(state.active);
      close();
      notify(t("imp.done"), "ok");
    } catch (cause) {
      setKey("");
      setPassword("");
      setError(describeError(cause));
    } finally {
      actionGate.leave();
      setBusy(false);
    }
  };
  return (
    <Panel title={t("imp.panel")}>
      <PanelBody>
        {!open ? (
          <>
            <Button block onClick={() => setOpen(true)}>
              {t("imp.button")}
            </Button>
            <Note>{t("imp.note")}</Note>
          </>
        ) : (
          <>
            <label className="w-field">
              <span className="w-label">{t("reveal.keyTitle")}</span>
              <input
                className="w-input"
                type="password"
                value={key}
                autoFocus
                disabled={busy}
                spellCheck={false}
                autoComplete="off"
                placeholder="0x…"
                aria-invalid={trimmed.length > 0 && !valid}
                onChange={(event) => {
                  setKey(event.target.value);
                  setError(null);
                }}
              />
            </label>
            <label className="w-field">
              <span className="w-label">{t("imp.nameLabel")}</span>
              <input
                className="w-input"
                value={label}
                disabled={busy}
                maxLength={24}
                autoComplete="off"
                onChange={(event) => setLabel(event.target.value)}
              />
            </label>
            <label className="w-field">
              <span className="w-label">{t("imp.passwordLabel")}</span>
              <input
                className="w-input"
                type="password"
                value={password}
                disabled={busy}
                autoComplete="current-password"
                aria-invalid={error !== null}
                onChange={(event) => {
                  setPassword(event.target.value);
                  setError(null);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && ready) void submit();
                }}
              />
            </label>
            {trimmed.length > 0 && !valid ? (
              <Note tone="error">{t("imp.badKey")}</Note>
            ) : null}
            {error !== null ? (
              <div role="alert">
                <Note tone="error">{error}</Note>
              </div>
            ) : null}
            <div className="w-btn-row">
              <Button block disabled={busy} onClick={close}>
                {t("common.cancel")}
              </Button>
              <Button
                variant="primary"
                block
                disabled={busy || !ready}
                onClick={() => void submit()}
              >
                {busy ? t("imp.importing") : t("imp.submit")}
              </Button>
            </div>
          </>
        )}
      </PanelBody>
    </Panel>
  );
}
