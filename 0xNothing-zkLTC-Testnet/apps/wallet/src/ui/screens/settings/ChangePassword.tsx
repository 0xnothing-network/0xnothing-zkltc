import { type ReactNode, useState } from "react";
import { t } from "../../../core/i18n";
import { changePassword, MIN_WALLET_PASSWORD_LENGTH } from "../../../core/keyring/vault";
import { describeError } from "../../../core/lib/errors";
import { Button, Note, Panel, PanelBody } from "../../components/kit";
import { useActionGate } from "../../hooks/useActionGate";
import { useWallet } from "../../state/WalletContext";

/**
 * Password rotation. The vault re-encrypts the same secret under the new
 * password and refreshes the session key, so the wallet stays unlocked and no
 * account is re-derived — the addresses cannot change.
 */
export function ChangePassword(): ReactNode {
  const { notify } = useWallet();
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [again, setAgain] = useState("");
  const [busy, setBusy] = useState(false);
  const actionGate = useActionGate();
  const [error, setError] = useState<string | null>(null);

  const tooShort = next.length > 0 && next.length < MIN_WALLET_PASSWORD_LENGTH;
  const mismatch = again.length > 0 && again !== next;
  const ready = current.length > 0
    && next.length >= MIN_WALLET_PASSWORD_LENGTH
    && again === next;

  const close = (): void => {
    setOpen(false);
    setCurrent("");
    setNext("");
    setAgain("");
    setError(null);
  };

  const submit = async (): Promise<void> => {
    if (busy || !ready || !actionGate.tryEnter()) return;
    setBusy(true);
    setError(null);
    try {
      await changePassword(current, next);
      close();
      notify(t("pwd.done"), "ok");
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      actionGate.leave();
      setBusy(false);
    }
  };
  return (
    <Panel title={t("common.password")}>
      <PanelBody>
        {!open ? (
          <>
            <Button
              block
              onClick={() => {
                setError(null);
                setOpen(true);
              }}
            >
              {t("pwd.change")}
            </Button>
            <Note>{t("pwd.note")}</Note>
          </>
        ) : (
          <>
            <label className="w-field">
              <span className="w-label">{t("pwd.current")}</span>
              <input
                className="w-input"
                type="password"
                value={current}
                autoFocus
                disabled={busy}
                autoComplete="current-password"
                aria-invalid={error !== null}
                onChange={(event) => {
                  setCurrent(event.target.value);
                  setError(null);
                }}
              />
            </label>
            <label className="w-field">
              <span className="w-label">{t("pwd.new")}</span>
              <input
                className="w-input"
                type="password"
                value={next}
                disabled={busy}
                autoComplete="new-password"
                aria-invalid={tooShort}
                onChange={(event) => {
                  setNext(event.target.value);
                  setError(null);
                }}
              />
            </label>
            <label className="w-field">
              <span className="w-label">{t("pwd.repeat")}</span>
              <input
                className="w-input"
                type="password"
                value={again}
                disabled={busy}
                autoComplete="new-password"
                aria-invalid={mismatch}
                onChange={(event) => {
                  setAgain(event.target.value);
                  setError(null);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && ready) void submit();
                }}
              />
            </label>
            {tooShort ? (
              <Note tone="warn">
                {t("onb.shortPassword", { min: MIN_WALLET_PASSWORD_LENGTH })}
              </Note>
            ) : null}
            {mismatch ? <Note tone="error">{t("pwd.mismatch")}</Note> : null}
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
                {busy ? t("pwd.saving") : t("common.confirm")}
              </Button>
            </div>
          </>
        )}
      </PanelBody>
    </Panel>
  );
}
