import { type ReactNode, useId, useRef, useState } from "react";
import { t } from "../../../core/i18n";
import {
  changePassword,
  passwordProblem,
  passwordProblemText,
  passwordStrength,
  type PasswordStrength,
} from "../../../core/keyring/vault";
import { describeError } from "../../../core/lib/errors";
import { Button, Note, Panel, PanelBody } from "../../components/kit";
import { useActionGate } from "../../hooks/useActionGate";
import { useWallet } from "../../state/WalletContext";

/**
 * Password rotation. The vault re-encrypts the same secret under the new
 * password and refreshes the session key, so the wallet stays unlocked and no
 * account is re-derived — the addresses cannot change.
 *
 * The fields are read-only while it runs, not disabled, so a wrong current
 * password keeps the focus; that field is selected for the retry.
 */

/** The meter only informs; what blocks Confirm is `passwordProblem`. */
const STRENGTH_TONE: Record<PasswordStrength, "warn" | "ok" | undefined> = {
  weak: "warn",
  fair: undefined,
  strong: "ok",
};
export function ChangePassword(): ReactNode {
  const { notify } = useWallet();
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [again, setAgain] = useState("");
  const [busy, setBusy] = useState(false);
  const actionGate = useActionGate();
  const [error, setError] = useState<string | null>(null);
  const currentRef = useRef<HTMLInputElement>(null);
  const errorId = useId();

  // The same check changePassword runs, so Confirm never enables for a password it refuses.
  const problem = passwordProblem(next);
  const refused = next.length > 0 && problem !== null;
  const strength = passwordStrength(next);
  const mismatch = again.length > 0 && again !== next;
  const ready = current.length > 0
    && problem === null
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
      requestAnimationFrame(() => currentRef.current?.select());
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
          <div className="w-set-form">
            <label className="w-field">
              <span className="w-label">{t("pwd.current")}</span>
              <input
                ref={currentRef}
                className="w-input"
                type="password"
                value={current}
                autoFocus
                readOnly={busy}
                autoComplete="current-password"
                aria-invalid={error !== null}
                aria-describedby={error !== null ? errorId : undefined}
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
                readOnly={busy}
                autoComplete="new-password"
                aria-invalid={refused}
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
                readOnly={busy}
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
            {next.length > 0 ? (
              <p className="w-caption" data-tone={STRENGTH_TONE[strength]}>
                {t("pwd.strengthLabel", { level: t(`pwd.strength.${strength}`) })}
                {strength === "strong" ? null : ` · ${t("pwd.hint")}`}
              </p>
            ) : null}
            {refused && problem !== null ? (
              <Note tone="warn">{passwordProblemText(problem)}</Note>
            ) : null}
            {mismatch ? <Note tone="error">{t("pwd.mismatch")}</Note> : null}
            {error !== null ? (
              <div role="alert" id={errorId}>
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
          </div>
        )}
      </PanelBody>
    </Panel>
  );
}
