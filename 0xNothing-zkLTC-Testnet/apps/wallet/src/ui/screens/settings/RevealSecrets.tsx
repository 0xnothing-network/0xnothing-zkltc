import { type ReactNode, useLayoutEffect, useRef, useState } from "react";
import { type MessageKey, t } from "../../../core/i18n";
import { describeError } from "../../../core/lib/errors";
import { revealMnemonic, revealPrivateKey } from "../../../core/keyring/vault";
import { Button, Note, Panel, PanelBody } from "../../components/kit";
import { useCopy } from "../../hooks/useCopy";
import { useWallet } from "../../state/WalletContext";

/**
 * Seed phrase and private key, each behind a fresh password entry even though
 * the wallet is already unlocked — an unlocked popup left on a desk should not
 * hand over the seed to whoever walks past it.
 *
 * The secret is held in component state only, cleared on every close, and never
 * written anywhere: no toast, no history record, no storage key.
 */
type Target = "mnemonic" | "key";

const TITLE: Record<Target, MessageKey> = {
  mnemonic: "reveal.mnemonicTitle",
  key: "reveal.keyTitle",
};

export function RevealSecrets(): ReactNode {
  const { address, notify } = useWallet();
  const [target, setTarget] = useState<Target | null>(null);
  const [password, setPassword] = useState("");
  const [secret, setSecret] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestIdRef = useRef(0);
  const { copied, copy } = useCopy();

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

  const open = (next: Target): void => {
    requestIdRef.current += 1;
    setTarget(next);
    setPassword("");
    setSecret(null);
    setError(null);
  };

  const submit = async (): Promise<void> => {
    if (busy || password.length === 0 || target === null || address === null) return;
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
      if (requestIdRef.current === requestId) setError(describeError(cause));
    } finally {
      if (requestIdRef.current === requestId) setBusy(false);
    }
  };
  return (
    <Panel title={t("reveal.panel")}>
      <PanelBody>
        {target === null ? (
          <>
            <div className="w-btn-row">
              <Button block disabled={address === null} onClick={() => open("mnemonic")}>
                {t("reveal.showMnemonic")}
              </Button>
              <Button block disabled={address === null} onClick={() => open("key")}>
                {t("reveal.showKey")}
              </Button>
            </div>
            <Note>{t("reveal.note")}</Note>
          </>
        ) : (
          <>
            <span className="w-label">{t(TITLE[target])}</span>
            {secret === null ? (
              <>
                <label className="w-field">
                  <span className="w-label">{t("reveal.confirmPassword")}</span>
                  <input
                    className="w-input"
                    type="password"
                    value={password}
                    autoFocus
                    disabled={busy}
                    autoComplete="current-password"
                    aria-invalid={error !== null}
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
                  <div role="alert">
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
                  <p className="w-code w-mono-break">{secret}</p>
                )}
                <div className="w-btn-row">
                  <Button
                    data-copied={copied ? "true" : "false"}
                    onClick={() => void copy(secret).then((ok) => {
                      if (!ok) notify(t("common.copyFailed"), "error");
                    })}
                  >
                    {copied ? `${t("common.copied")} ✓` : t("common.copy")}
                  </Button>
                  <Button variant="primary" block onClick={close}>
                    {t("reveal.hide")}
                  </Button>
                </div>
                <Note tone="warn">{t("reveal.warning")}</Note>
              </>
            )}
          </>
        )}
      </PanelBody>
    </Panel>
  );
}
