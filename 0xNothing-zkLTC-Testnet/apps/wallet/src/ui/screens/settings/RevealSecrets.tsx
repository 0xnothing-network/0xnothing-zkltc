import { type ReactNode, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { type MessageKey, t } from "../../../core/i18n";
import { describeError } from "../../../core/lib/errors";
import { revealMnemonic, revealPrivateKey } from "../../../core/keyring/vault";
import { Button, Note, Panel, PanelBody } from "../../components/kit";
import { useActionGate } from "../../hooks/useActionGate";
import { useWallet } from "../../state/WalletContext";

/**
 * Seed phrase and private key, each behind a fresh password entry even though
 * the wallet is already unlocked — an unlocked popup left on a desk should not
 * hand over the seed to whoever walks past it.
 *
 * The secret is held in component state only, cleared on every close, and never
 * written anywhere: no toast, no history record, no storage key, no clipboard.
 * Every app can read the clipboard, and Windows clipboard history and cloud sync
 * keep a copy that no timed clear reaches. The text stays selectable, so a copy
 * by hand remains possible as a deliberate act — except on Android, where a
 * long-press hands the words to the selection bar (Copy, Share, Translate, Lens)
 * and the keyboard's clipboard sync, so there they are not selectable at all.
 *
 * A shown secret is also hidden on its own: the moment the page is hidden (the
 * app sent to the background, the phone asleep, the tab switched) and after
 * REVEAL_MAX_MS on screen. Whoever picks the device up later finds the buttons,
 * not the words; seeing them again costs the password again.
 */
type Target = "mnemonic" | "key";

/** How long a revealed secret may stay on screen. */
export const REVEAL_MAX_MS = 60_000;

type VisibilitySource = Pick<Document, "hidden" | "addEventListener" | "removeEventListener">;
type Timers = {
  setTimeout: (run: () => void, ms: number) => unknown;
  clearTimeout: (handle: never) => void;
};

/**
 * Calls `hide` once the page is hidden, or once `ms` has passed, whichever comes
 * first; a page already hidden when the secret arrives hides it at once. Returns
 * the cleanup for an effect.
 */
export function hideWhenAway(
  page: VisibilitySource,
  hide: () => void,
  timers: Timers,
  ms = REVEAL_MAX_MS,
): () => void {
  const onVisibility = (): void => {
    if (page.hidden) hide();
  };
  page.addEventListener("visibilitychange", onVisibility);
  const timer = timers.setTimeout(hide, ms);
  if (page.hidden) hide();
  return () => {
    page.removeEventListener("visibilitychange", onVisibility);
    timers.clearTimeout(timer as never);
  };
}

const TITLE: Record<Target, MessageKey> = {
  mnemonic: "reveal.mnemonicTitle",
  key: "reveal.keyTitle",
};

export function RevealSecrets(): ReactNode {
  const { address } = useWallet();
  const [target, setTarget] = useState<Target | null>(null);
  const [password, setPassword] = useState("");
  const [secret, setSecret] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestIdRef = useRef(0);
  const actionGate = useActionGate();
  const passwordRef = useRef<HTMLInputElement>(null);
  const errorId = useId();

  // Switching accounts or unmounting invalidates an in-progress decrypt. A
  // late result must never appear under a different account/secret heading.
  useLayoutEffect(() => {
    requestIdRef.current += 1;
    setTarget(null);
    setPassword("");
    setSecret(null);
    setBusy(false);
    setError(null);
    return () => {
      requestIdRef.current += 1;
    };
  }, [address]);

  const close = (): void => {
    requestIdRef.current += 1;
    setTarget(null);
    setPassword("");
    setSecret(null);
    setBusy(false);
    setError(null);
  };

  // close() only calls setters and bumps the ref, so this closure never goes stale.
  useEffect(() => {
    if (secret === null) return;
    return hideWhenAway(document, close, { setTimeout, clearTimeout });
  }, [secret]);

  const open = (next: Target): void => {
    requestIdRef.current += 1;
    setTarget(next);
    setPassword("");
    setSecret(null);
    setError(null);
  };

  const submit = async (): Promise<void> => {
    if (busy || password.length === 0 || target === null || address === null) return;
    // The field stays focused while the vault works, so Enter can land twice
    // before `busy` re-renders; the gate holds the second press off.
    if (!actionGate.tryEnter()) return;
    const requestedTarget = target;
    const requestedAddress = address;
    const requestedPassword = password;
    const requestId = ++requestIdRef.current;
    setBusy(true);
    setError(null);
    try {
      const value = requestedTarget === "mnemonic"
        ? await revealMnemonic(requestedPassword)
        : await revealPrivateKey(requestedPassword, requestedAddress);
      if (requestIdRef.current !== requestId) return;
      setSecret(value);
      setPassword("");
    } catch (cause) {
      if (requestIdRef.current === requestId) {
        setError(describeError(cause));
        requestAnimationFrame(() => passwordRef.current?.select());
      }
    } finally {
      actionGate.leave();
      if (requestIdRef.current === requestId) setBusy(false);
    }
  };
  return (
    <Panel title={t("reveal.panel")}>
      <PanelBody>
        {target === null ? (
          <>
            <Button block disabled={address === null} onClick={() => open("mnemonic")}>
              {t("reveal.showMnemonic")}
            </Button>
            <Button block disabled={address === null} onClick={() => open("key")}>
              {t("reveal.showKey")}
            </Button>
            <Note>{t("reveal.note")}</Note>
          </>
        ) : (
          <div className="w-set-form">
            <span className="w-label">{t(TITLE[target])}</span>
            {secret === null ? (
              <>
                <label className="w-field">
                  <span className="w-label">{t("reveal.confirmPassword")}</span>
                  <input
                    ref={passwordRef}
                    className="w-input"
                    type="password"
                    value={password}
                    autoFocus
                    readOnly={busy}
                    autoComplete="current-password"
                    aria-invalid={error !== null}
                    aria-describedby={error !== null ? errorId : undefined}
                    onChange={(event) => {
                      setPassword(event.target.value);
                      setError(null);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" && password.length > 0) void submit();
                    }}
                  />
                </label>
                {error !== null ? (
                  <div role="alert" id={errorId}>
                    <Note tone="error">{error}</Note>
                  </div>
                ) : null}
                <div className="w-btn-row">
                  <Button block onClick={close}>
                    {t("common.cancel")}
                  </Button>
                  <Button
                    variant="primary"
                    block
                    disabled={busy || password.length === 0}
                    onClick={() => void submit()}
                  >
                    {busy ? t("unlock.opening") : t("reveal.reveal")}
                  </Button>
                </div>
              </>
            ) : (
              <>
                {target === "mnemonic" ? (
                  <div className="w-seed">
                    {secret.split(" ").map((word, index) => (
                      <span key={`${index}-${word}`} className="w-word">
                        {index + 1}. {word}
                      </span>
                    ))}
                  </div>
                ) : (
                  <p className="w-code w-mono-break w-secret">{secret}</p>
                )}
                <div className="w-btn-row">
                  <Button variant="primary" block onClick={close}>
                    {t("reveal.hide")}
                  </Button>
                </div>
                <Note tone="warn">{t("reveal.warning")}</Note>
              </>
            )}
          </div>
        )}
      </PanelBody>
    </Panel>
  );
}
