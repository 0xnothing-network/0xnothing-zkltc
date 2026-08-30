import { type ReactNode, useState } from "react";
import { t } from "../../core/i18n";
import { checkMnemonic, completeWord, newMnemonic } from "../../core/keyring/mnemonic";
import { createVault, MIN_WALLET_PASSWORD_LENGTH } from "../../core/keyring/vault";
import { describeError } from "../../core/lib/errors";
import { copyText } from "../../core/platform/env";
import { Button, Note } from "../components/kit";
import { Screen } from "../components/Screen";
import { useWallet } from "../state/WalletContext";

/**
 * First run. Three steps and no network call: a wallet is created or restored
 * entirely on the device, and the password never leaves it either — it only ever
 * derives the AES key the vault is sealed with.
 *
 * The phrase is checked against the BIP-39 checksum before it is accepted, so a
 * mistyped word is refused here instead of quietly restoring an empty account.
 */
type Step = "choose" | "create" | "import" | "password";

export function Onboarding(): ReactNode {
  const { openWallet, notify } = useWallet();
  const [step, setStep] = useState<Step>("choose");
  const [phrase, setPhrase] = useState("");
  const [typed, setTyped] = useState("");
  const [saved, setSaved] = useState(false);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const words = phrase.length === 0 ? [] : phrase.split(" ");
  const tail = typed.split(/\s+/u).at(-1) ?? "";
  const suggestions = completeWord(tail);
  const typedReady = typed.trim().length > 0;
  const passwordTooShort = password.length > 0 && password.length < MIN_WALLET_PASSWORD_LENGTH;
  const passwordsMismatch = confirm.length > 0 && password !== confirm;
  const passwordReady = password.length >= MIN_WALLET_PASSWORD_LENGTH && confirm === password;

  const startCreate = (): void => {
    setPhrase(newMnemonic());
    setSaved(false);
    setError(null);
    setStep("create");
  };

  const acceptTyped = async (): Promise<void> => {
    if (busy || !typedReady) return;
    setBusy(true);
    setError(null);
    try {
      const checked = await checkMnemonic(typed);
      if (!checked.ok) {
        setError(
          checked.reason === "length"
            ? t("onb.badLength")
            : checked.reason === "word"
              ? t("onb.badWord", { word: checked.word ?? "" })
              : t("onb.badChecksum"),
        );
        return;
      }
      setPhrase(checked.phrase);
      setStep("password");
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      setBusy(false);
    }
  };
  const install = async (): Promise<void> => {
    if (busy) return;
    if (password.length < MIN_WALLET_PASSWORD_LENGTH) {
      setError(t("onb.shortPassword", { min: MIN_WALLET_PASSWORD_LENGTH }));
      return;
    }
    if (password !== confirm) {
      setError(t("onb.mismatch"));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await createVault(password, phrase);
      // Nothing keeps the phrase after this point; it lives in the sealed vault.
      setPhrase("");
      setTyped("");
      setPassword("");
      setConfirm("");
      await openWallet();
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      setBusy(false);
    }
  };

  const back = (): void => {
    setError(null);
    setStep(typed.trim().length > 0 ? "import" : "choose");
  };

  if (step === "choose") {
    return (
      <Screen title={t("onb.title")}>
        <div className="w-stack">
          <Note>{t("onb.intro")}</Note>
          <Button variant="primary" block onClick={startCreate}>
            {t("onb.create")}
          </Button>
          <Button
            block
            onClick={() => {
              setError(null);
              setStep("import");
            }}
          >
            {t("onb.import")}
          </Button>
        </div>
      </Screen>
    );
  }
  if (step === "create") {
    return (
      <Screen
        title={t("onb.phraseTitle")}
        onBack={() => {
          setPhrase("");
          setSaved(false);
          setStep("choose");
        }}
      >
        <div className="w-flow">
          <div className="w-flow-main">
            <Note tone="warn">{t("onb.phraseWarn")}</Note>
            <div className="w-seed">
              {words.map((word, index) => (
                <span className="w-word" key={`${index}-${word}`}>
                  <span>{index + 1}</span>
                  {word}
                </span>
              ))}
            </div>
            <div className="w-btn-row">
              <Button
                onClick={() => {
                  void copyText(phrase).then((ok) =>
                    notify(
                      ok ? t("onb.phraseCopied") : t("common.copyFailed"),
                      ok ? "ok" : "error",
                    ),
                  );
                }}
              >
                {t("common.copy")}
              </Button>
              <Button onClick={startCreate}>{t("onb.regenerate")}</Button>
            </div>
            <label className="w-split">
              <span className="w-hint">{t("onb.savedCheck")}</span>
              <input
                className="w-check"
                type="checkbox"
                checked={saved}
                onChange={(event) => setSaved(event.target.checked)}
              />
            </label>
          </div>
          <div className="w-flow-actions">
            <Button
              variant="primary"
              block
              disabled={!saved}
              onClick={() => {
                setError(null);
                setStep("password");
              }}
            >
              {t("common.continue")}
            </Button>
          </div>
        </div>
      </Screen>
    );
  }
  if (step === "import") {
    return (
      <Screen title={t("onb.importTitle")} onBack={() => setStep("choose")}>
        <div className="w-flow" aria-busy={busy}>
          <div className="w-flow-main">
            <label className="w-field">
              <span className="w-label">{t("onb.phraseTitle")}</span>
              <textarea
                className="w-input"
                value={typed}
                rows={4}
                spellCheck={false}
                autoCapitalize="none"
                autoComplete="off"
                autoFocus
                disabled={busy}
                aria-label={t("onb.phraseTitle")}
                aria-invalid={error !== null}
                placeholder={t("onb.phrasePlaceholder")}
                onChange={(event) => {
                  setTyped(event.target.value);
                  setError(null);
                }}
              />
            </label>
            {suggestions.length > 0 ? (
              <div className="w-btn-row">
                {suggestions.map((word) => (
                  <Button
                    key={word}
                    size="sm"
                    disabled={busy}
                    onClick={() =>
                      setTyped((current) => `${current.replace(/\S*$/u, "")}${word} `)
                    }
                  >
                    {word}
                  </Button>
                ))}
              </div>
            ) : null}
            {error ? (
              <div role="alert">
                <Note tone="error">{error}</Note>
              </div>
            ) : null}
          </div>
          <div className="w-flow-actions">
            <Button
              variant="primary"
              block
              disabled={busy || !typedReady}
              onClick={() => void acceptTyped()}
            >
              {busy ? t("common.working") : t("common.continue")}
            </Button>
          </div>
        </div>
      </Screen>
    );
  }
  return (
    <Screen
      title={t("common.password")}
      onBack={() => {
        if (!busy) back();
      }}
    >
      <div className="w-flow" aria-busy={busy}>
        <div className="w-flow-main">
          <Note>{t("onb.passwordNote")}</Note>
          <label className="w-field">
          <span className="w-label">{t("common.password")}</span>
          <input
            className="w-input"
            type="password"
            value={password}
            autoComplete="new-password"
            autoFocus
            disabled={busy}
            aria-label={t("common.password")}
            aria-invalid={passwordTooShort}
            onChange={(event) => {
              setPassword(event.target.value);
              setError(null);
            }}
          />
          </label>
          <label className="w-field">
          <span className="w-label">{t("onb.repeat")}</span>
          <input
            className="w-input"
            type="password"
            value={confirm}
            autoComplete="new-password"
            disabled={busy}
            aria-label={t("onb.repeatAria")}
            aria-invalid={passwordsMismatch}
            onChange={(event) => {
              setConfirm(event.target.value);
              setError(null);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" && passwordReady) void install();
            }}
          />
          </label>
          {passwordTooShort ? (
            <Note tone="warn">{t("onb.shortPassword", { min: MIN_WALLET_PASSWORD_LENGTH })}</Note>
          ) : null}
          {passwordsMismatch ? <Note tone="error">{t("onb.mismatch")}</Note> : null}
          {error ? (
            <div role="alert">
              <Note tone="error">{error}</Note>
            </div>
          ) : null}
        </div>
        <div className="w-flow-actions">
          <Button
            variant="primary"
            block
            disabled={busy || !passwordReady}
            onClick={() => void install()}
          >
            {busy ? t("onb.creating") : t("unlock.title")}
          </Button>
        </div>
      </div>
    </Screen>
  );
}
