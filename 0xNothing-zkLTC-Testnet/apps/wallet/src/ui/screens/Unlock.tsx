import { type ReactNode, useEffect, useId, useMemo, useRef, useState } from "react";
import { t } from "../../core/i18n";
import {
  accountLabel,
  secondsUntil,
  unlock,
  unlockRetryAt,
  UnlockThrottledError,
  wipeWallet,
  WrongPasswordError,
} from "../../core/keyring/vault";
import { shortenAddress } from "../../core/lib/format";
import { describeError } from "../../core/lib/errors";
import { Button, Note, Wordmark } from "../components/kit";
import { useActionGate } from "../hooks/useActionGate";
import { Screen } from "../components/Screen";
import { useWallet } from "../state/WalletContext";
import { releaseCustomRpcPermissions, releaseNotificationsBeforeErase } from "./settings/rpcRelease";

/**
 * The lock screen. Unlocking is a local key derivation — no request leaves the
 * device — so a wrong password fails instantly and cannot be probed remotely.
 * After five misses in a row the vault makes each further try wait (up to 15
 * min); the screen shows the time left instead of a button that would refuse.
 *
 * The reset at the bottom is the only way out for someone who has lost the
 * password: the vault cannot be decrypted without it, so pretending otherwise
 * would just leave the user stuck at this screen forever.
 *
 * The confirmation word is translated with the rest of the screen, so it is
 * compared case-insensitively rather than against one fixed spelling.
 *
 * While a try runs the field is read-only, not disabled: a disabled field loses
 * focus, so after a wrong password the caret was gone and, on Android, the
 * keyboard closed. The miss selects the text instead, ready to be retyped.
 */
export function Unlock(): ReactNode {
  const { active, openWallet } = useWallet();
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [confirmWord, setConfirmWord] = useState("");
  const actionGate = useActionGate();
  const passwordRef = useRef<HTMLInputElement>(null);
  const errorId = useId();
  const wipeWord = t("wipe.word");
  const wipeReady = confirmWord.trim().toUpperCase() === wipeWord.toUpperCase();

  // The guard outlives this window, so a reopened popup shows the wait it left.
  const [retryAt, setRetryAt] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const waiting = retryAt > now;
  // The visible count ticks every second; a live region doing so would be read
  // out every second for up to 15 minutes. Screen readers get one sentence per
  // new wait instead, with the seconds left when it began.
  const announcedSeconds = useMemo(() => secondsUntil(retryAt), [retryAt]);
  useEffect(() => {
    let live = true;
    void unlockRetryAt().then((at) => {
      if (live) setRetryAt(at);
    }).catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);
  useEffect(() => {
    if (!waiting) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [waiting]);

  const submit = async (): Promise<void> => {
    if (busy || waiting || password.length === 0 || !actionGate.tryEnter()) return;
    setBusy(true);
    setError(null);
    try {
      await unlock(password);
      setPassword("");
      await openWallet();
    } catch (cause) {
      if (cause instanceof UnlockThrottledError) {
        setNow(Date.now());
        setRetryAt(cause.retryAt);
      } else {
        setError(
          cause instanceof WrongPasswordError ? t("vault.wrongPassword") : describeError(cause),
        );
        requestAnimationFrame(() => passwordRef.current?.select());
        // The fifth miss in a row starts a wait; show it now, not on the next try.
        if (cause instanceof WrongPasswordError) {
          const at = await unlockRetryAt().catch(() => 0);
          setNow(Date.now());
          setRetryAt(at);
        }
      }
    } finally {
      actionGate.leave();
      setBusy(false);
    }
  };

  const wipe = async (): Promise<void> => {
    if (busy || !wipeReady || !actionGate.tryEnter()) return;
    setBusy(true);
    setError(null);
    try {
      // The custom RPC host grants go first, while the profiles naming them
      // can still be read; this never throws. So does the notifications release.
      await releaseNotificationsBeforeErase();
      await releaseCustomRpcPermissions();
      await wipeWallet();
      // A full reload is the cleanest way back to onboarding: nothing from the
      // old vault stays in memory, not even in this component's state.
      window.location.reload();
    } catch (cause) {
      setError(describeError(cause));
      actionGate.leave();
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
    <Screen title={t("unlock.title")} bare={!resetting}>
      <div
        className="w-flow w-onb"
        data-step={resetting ? "reset" : "unlock"}
        aria-busy={busy}
        data-lock={resetting ? undefined : "true"}
      >
        <div className="w-flow-main">
          {resetting ? null : (
            <Wordmark
              sub={active
                ? `${accountLabel(active)} · ${shortenAddress(active.address)}`
                : undefined}
            />
          )}
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
                <span className="w-label w-sr-only">{t("common.password")}</span>
                <input
                  ref={passwordRef}
                  className="w-input"
                  type="password"
                  value={password}
                  autoComplete="current-password"
                  autoFocus
                  readOnly={busy}
                  aria-label={t("common.password")}
                  aria-invalid={error !== null}
                  aria-describedby={error && !waiting ? errorId : undefined}
                  onChange={(event) => {
                    setPassword(event.target.value);
                    setError(null);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") void submit();
                  }}
                />
              </label>
              {error && !waiting ? (
                <div role="alert">
                  <p className="w-caption" data-tone="error" id={errorId}>{error}</p>
                </div>
              ) : null}
              {waiting ? (
                <div>
                  <p className="w-caption" data-tone="warn" aria-hidden="true">
                    {t("unlock.throttled", { seconds: secondsUntil(retryAt, now) })}
                  </p>
                  <p className="w-sr-only" role="status">
                    {t("unlock.throttled", { seconds: announcedSeconds })}
                  </p>
                </div>
              ) : null}
              <Button
                variant="primary"
                block
                disabled={busy || waiting || password.length === 0}
                onClick={() => void submit()}
              >
                {busy ? t("unlock.opening") : t("unlock.title")}
              </Button>
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
            <Button variant="ghost" size="sm" disabled={busy} onClick={showReset}>
              {t("unlock.forgot")}
            </Button>
          )}
        </div>
      </div>
    </Screen>
  );
}
