import { type ReactNode, useState } from "react";
import { t } from "../../core/i18n";
import { unlock, wipeWallet, WrongPasswordError } from "../../core/keyring/vault";
import { describeError } from "../../core/lib/errors";
import { Button, Note } from "../components/kit";
import { Screen } from "../components/Screen";
import { useWallet } from "../state/WalletContext";

/**
 * The lock screen. Unlocking is a local key derivation — no request leaves the
 * device — so a wrong password fails instantly and cannot be probed remotely.
 *
 * The reset at the bottom is the only way out for someone who has lost the
 * password: the vault cannot be decrypted without it, so pretending otherwise
 * would just leave the user stuck at this screen forever.
 *
 * The confirmation word is translated with the rest of the screen, so it is
 * compared case-insensitively rather than against one fixed spelling.
 */
export function Unlock(): ReactNode {
  const { openWallet } = useWallet();
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [confirmWord, setConfirmWord] = useState("");
  const wipeWord = t("wipe.word");
  const wipeReady = confirmWord.trim().toUpperCase() === wipeWord.toUpperCase();

  const submit = async (): Promise<void> => {
    if (busy || password.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      await unlock(password);
      setPassword("");
      await openWallet();
    } catch (cause) {
      setError(
        cause instanceof WrongPasswordError ? t("vault.wrongPassword") : describeError(cause),
      );
    } finally {
      setBusy(false);
    }
  };

  const wipe = async (): Promise<void> => {
    if (busy || !wipeReady) return;
    setBusy(true);
    setError(null);
    try {
      await wipeWallet();
      // A full reload is the cleanest way back to onboarding: nothing from the
      // old vault stays in memory, not even in this component's state.
      window.location.reload();
    } catch (cause) {
      setError(describeError(cause));
      setBusy(false);
    }
  };

  const showReset = (): void => {
    setConfirmWord("");
    setError(null);
    setResetting(true);
  };

  const cancelReset = (): void => {
    setConfirmWord("");
    setError(null);
    setResetting(false);
  };

  return (
    <Screen title={t("unlock.title")}>
      <div className="w-flow" aria-busy={busy}>
        <div className="w-flow-main">
          {resetting ? (
            <>
            <Note tone="warn">{t("unlock.wipeWarning", { word: wipeWord })}</Note>
            <input
              className="w-input"
              value={confirmWord}
              autoFocus
              disabled={busy}
              spellCheck={false}
              autoComplete="off"
              aria-label={t("wipe.inputAria", { word: wipeWord })}
              aria-invalid={confirmWord.length > 0 && !wipeReady}
              onChange={(event) => {
                setConfirmWord(event.target.value);
                setError(null);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" && wipeReady) void wipe();
              }}
            />
            {error ? (
              <div role="alert">
                <Note tone="error">{error}</Note>
              </div>
            ) : null}
            </>
          ) : (
            <>
              <label className="w-field">
                <span className="w-label">{t("common.password")}</span>
                <input
                  className="w-input"
                  type="password"
                  value={password}
                  autoComplete="current-password"
                  autoFocus
                  disabled={busy}
                  aria-label={t("common.password")}
                  aria-invalid={error !== null}
                  onChange={(event) => {
                    setPassword(event.target.value);
                    setError(null);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") void submit();
                  }}
                />
              </label>
              {error ? (
                <div role="alert">
                  <Note tone="error">{error}</Note>
                </div>
              ) : null}
            </>
          )}
        </div>
        <div className="w-flow-actions">
          {resetting ? (
            <div className="w-btn-row">
              <Button disabled={busy} onClick={cancelReset}>
                {t("common.cancel")}
              </Button>
              <Button
                variant="danger"
                disabled={busy || !wipeReady}
                onClick={() => void wipe()}
              >
                {busy ? t("danger.deleting") : t("wipe.action")}
              </Button>
            </div>
          ) : (
            <>
            <Button
              variant="primary"
              block
              disabled={busy || password.length === 0}
              onClick={() => void submit()}
            >
              {busy ? t("unlock.opening") : t("unlock.title")}
            </Button>
            <Button size="sm" disabled={busy} onClick={showReset}>
              {t("unlock.forgot")}
            </Button>
            </>
          )}
        </div>
      </div>
    </Screen>
  );
}
