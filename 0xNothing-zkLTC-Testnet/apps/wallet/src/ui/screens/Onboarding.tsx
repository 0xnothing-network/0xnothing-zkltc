import { type ReactNode, useState } from "react";
import { t } from "../../core/i18n";
import {
  backupCheckChoices,
  backupCheckPositions,
  checkMnemonic,
  completeWord,
  newMnemonic,
  sameWord,
} from "../../core/keyring/mnemonic";
import {
  createVault,
  MIN_WALLET_PASSWORD_LENGTH,
  passwordProblem,
  passwordProblemText,
  passwordStrength,
  type PasswordStrength,
} from "../../core/keyring/vault";
import { describeError } from "../../core/lib/errors";
import { Button, Icon, Note, Wordmark } from "../components/kit";
import { useActionGate } from "../hooks/useActionGate";
import { Screen } from "../components/Screen";
import { useWallet } from "../state/WalletContext";

/**
 * First run, with no network call: a wallet is created or restored entirely on
 * the device, and the password never leaves it either — it only ever derives the
 * AES key the vault is sealed with.
 *
 * The phrase is checked against the BIP-39 checksum before it is accepted, so a
 * mistyped word is refused here instead of quietly restoring an empty account.
 * A new phrase has no copy button, for the reason RevealSecrets gives: the
 * clipboard keeps it long after this screen is gone.
 *
 * A new phrase is also asked back before it is sealed — three words at random
 * positions — because a ticked "I have written it down" proves nothing, and a
 * wallet without a real backup is lost with the device. A wrong word ends the
 * check and sends the user back to the same words; restoring skips the step.
 */
type Step = "choose" | "create" | "verify" | "import" | "password";

/** The backup check in progress: which positions, which one is asked, its choices. */
type BackupCheck = { positions: number[]; round: number; choices: string[] };

/** The meter only informs; what blocks Continue is `passwordProblem`. */
const STRENGTH_TONE: Record<PasswordStrength, "warn" | "ok" | undefined> = {
  weak: "warn",
  fair: undefined,
  strong: "ok",
};

export function Onboarding(): ReactNode {
  const { network, openWallet } = useWallet();
  const [step, setStep] = useState<Step>("choose");
  const [phrase, setPhrase] = useState("");
  const [typed, setTyped] = useState("");
  const [saved, setSaved] = useState(false);
  const [check, setCheck] = useState<BackupCheck | null>(null);
  const [answer, setAnswer] = useState("");
  const [wrong, setWrong] = useState(false);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [showSecret, setShowSecret] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const actionGate = useActionGate();

  const words = phrase.length === 0 ? [] : phrase.split(" ");
  const tail = typed.split(/\s+/u).at(-1) ?? "";
  const suggestions = completeWord(tail);
  const typedReady = typed.trim().length > 0;
  // The same check createVault runs, so Continue never enables for a password it refuses.
  const problem = passwordProblem(password);
  const passwordTooShort = password.length > 0 && problem === "onb.shortPassword";
  const passwordRefused = password.length > 0 && problem !== null && !passwordTooShort;
  const passwordsMismatch = confirm.length > 0 && password !== confirm;
  const passwordReady = problem === null && confirm === password;
  const strength = passwordStrength(password);

  const startCreate = (): void => {
    setPhrase(newMnemonic());
    // Restore text left from an earlier visit would make Back and the step count
    // treat this as a restore; it is a secret, too, with no reason to linger.
    setTyped("");
    setSaved(false);
    setCheck(null);
    setError(null);
    setStep("create");
  };

  // Fresh positions on every visit, so going back and forth cannot be learnt by rote.
  const startCheck = (): void => {
    const positions = backupCheckPositions(words.length);
    setCheck({ positions, round: 0, choices: backupCheckChoices(words, positions[0]!) });
    setAnswer("");
    setWrong(false);
    setError(null);
    setStep("verify");
  };

  const answerCheck = (value: string): void => {
    if (check === null || wrong) return;
    const position = check.positions[check.round]!;
    if (!sameWord(value, words[position] ?? "")) {
      setWrong(true);
      return;
    }
    setAnswer("");
    const round = check.round + 1;
    if (round >= check.positions.length) {
      setCheck(null);
      setStep("password");
      return;
    }
    setCheck({ ...check, round, choices: backupCheckChoices(words, check.positions[round]!) });
  };

  const backToPhrase = (): void => {
    setCheck(null);
    setAnswer("");
    setWrong(false);
    setStep("create");
  };

  const acceptTyped = async (): Promise<void> => {
    if (busy || !typedReady || !actionGate.tryEnter()) return;
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
      actionGate.leave();
      setBusy(false);
    }
  };
  const install = async (): Promise<void> => {
    if (busy) return;
    if (problem !== null) {
      setError(passwordProblemText(problem));
      return;
    }
    if (password !== confirm) {
      setError(t("onb.mismatch"));
      return;
    }
    if (!actionGate.tryEnter()) return;
    setBusy(true);
    setError(null);
    try {
      await createVault(password, phrase);
      // Nothing keeps the phrase after this point; it lives in the sealed vault.
      setPhrase("");
      setCheck(null);
      setTyped("");
      setPassword("");
      setConfirm("");
      await openWallet();
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      actionGate.leave();
      setBusy(false);
    }
  };

  const back = (): void => {
    setError(null);
    // A created phrase goes back to its own words: from "choose", Create would show a
    // new phrase while the user's paper backup still holds the old one.
    setStep(typed.trim().length > 0 ? "import" : phrase.length > 0 ? "create" : "choose");
  };

  if (step === "choose") {
    return (
      <Screen title={t("onb.title")} bare>
        <div className="w-stack w-welcome">
          <Wordmark sub="by 0xNothing" />
          <Note>{t("onb.intro")}</Note>
          <div className="w-welcome-actions">
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
            <p className="w-foot-caption">
              {network.name} · {t("set.chainId")} {network.chainId}
            </p>
          </div>
        </div>
      </Screen>
    );
  }
  if (step === "create") {
    return (
      <Screen
        title={t("onb.phraseTitle")}
        step="2 / 4"
        onBack={() => {
          setPhrase("");
          setSaved(false);
          setStep("choose");
        }}
      >
        <div className="w-flow w-onb" data-step="seed">
          <div className="w-flow-main">
            <Note tone="error">{t("onb.phraseWarn")}</Note>
            <div className="w-seed">
              {words.map((word, index) => (
                <span className="w-word" key={`${index}-${word}`}>
                  <span>{index + 1}</span>
                  {word}
                </span>
              ))}
            </div>
            <div className="w-regen">
              <Button variant="ghost" size="sm" onClick={startCreate}>
                ↻ {t("onb.regenerate")}
              </Button>
            </div>
          </div>
          <div className="w-flow-actions">
            <label className="w-check-row">
              <input
                className="w-check"
                type="checkbox"
                checked={saved}
                onChange={(event) => setSaved(event.target.checked)}
              />
              <span className="w-hint">{t("onb.savedCheck")}</span>
            </label>
            <Button
              variant="primary"
              block
              disabled={!saved}
              onClick={startCheck}
            >
              {t("common.continue")}
            </Button>
          </div>
        </div>
      </Screen>
    );
  }
  if (step === "verify" && check !== null) {
    const position = check.positions[check.round]!;
    return (
      <Screen title={t("onb.verifyTitle")} step="3 / 4" onBack={backToPhrase}>
        <div className="w-flow w-onb" data-step="verify">
          <div className="w-flow-main">
            <Note>{t("onb.verifyIntro")}</Note>
            <label className="w-field">
              <span className="w-label">{t("onb.verifyWord", { n: position + 1 })}</span>
              <input
                key={position}
                className="w-input"
                value={answer}
                autoFocus
                readOnly={wrong}
                spellCheck={false}
                autoCorrect="off"
                autoCapitalize="none"
                autoComplete="off"
                aria-invalid={wrong}
                onChange={(event) => setAnswer(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && answer.trim().length > 0) answerCheck(answer);
                }}
              />
            </label>
            {wrong ? (
              <div role="alert">
                <Note tone="error">{t("onb.verifyWrong")}</Note>
              </div>
            ) : (
              <div className="w-btn-row w-onb-suggest">
                {check.choices.map((word) => (
                  <Button key={word} size="sm" onClick={() => answerCheck(word)}>
                    {word}
                  </Button>
                ))}
              </div>
            )}
          </div>
          <div className="w-flow-actions">
            {wrong ? (
              <Button variant="primary" block onClick={backToPhrase}>
                {t("onb.verifyBack")}
              </Button>
            ) : (
              <Button
                variant="primary"
                block
                disabled={answer.trim().length === 0}
                onClick={() => answerCheck(answer)}
              >
                {t("common.continue")}
              </Button>
            )}
          </div>
        </div>
      </Screen>
    );
  }
  if (step === "import") {
    return (
      <Screen title={t("onb.importTitle")} step="2 / 3" onBack={() => setStep("choose")}>
        <div className="w-flow w-onb" data-step="import" aria-busy={busy}>
          <div className="w-flow-main">
            <label className="w-field">
              <span className="w-label">{t("onb.phraseTitle")}</span>
              <textarea
                className="w-input"
                value={typed}
                rows={4}
                spellCheck={false}
                autoCorrect="off"
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
              <div className="w-btn-row w-onb-suggest">
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
      step={typed.trim().length > 0 ? "3 / 3" : "4 / 4"}
      onBack={() => {
        if (!busy) back();
      }}
    >
      <div className="w-flow w-onb" data-step="password" aria-busy={busy}>
        <div className="w-flow-main">
          <label className="w-field">
            <span className="w-label">{t("common.password")}</span>
            <span className="w-secret">
              <input
                className="w-input"
                type={showSecret ? "text" : "password"}
                spellCheck={false}
                autoCorrect="off"
                autoCapitalize="none"
                value={password}
                autoComplete="new-password"
                autoFocus
                disabled={busy}
                aria-label={t("common.password")}
                aria-invalid={passwordTooShort || passwordRefused}
                onChange={(event) => {
                  setPassword(event.target.value);
                  setError(null);
                }}
              />
              <button
                type="button"
                className="w-secret-toggle"
                aria-label={t("common.password")}
                aria-pressed={showSecret}
                onClick={() => setShowSecret((current) => !current)}
              >
                <Icon name={showSecret ? "eyeOff" : "eye"} size={16} />
              </button>
            </span>
          </label>
          <label className="w-field">
            <span className="w-label">{t("onb.repeat")}</span>
            <span className="w-secret">
              <input
                className="w-input"
                type={showSecret ? "text" : "password"}
                spellCheck={false}
                autoCorrect="off"
                autoCapitalize="none"
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
              <button
                type="button"
                className="w-secret-toggle"
                aria-label={t("common.password")}
                aria-pressed={showSecret}
                onClick={() => setShowSecret((current) => !current)}
              >
                <Icon name={showSecret ? "eyeOff" : "eye"} size={16} />
              </button>
            </span>
          </label>
          <p className="w-caption" data-tone={passwordTooShort ? "warn" : undefined}>
            {t("onb.shortPassword", { min: MIN_WALLET_PASSWORD_LENGTH })}
          </p>
          {password.length > 0 ? (
            <p className="w-caption" data-tone={STRENGTH_TONE[strength]}>
              {t("pwd.strengthLabel", { level: t(`pwd.strength.${strength}`) })}
              {strength === "strong" ? null : ` · ${t("pwd.hint")}`}
            </p>
          ) : null}
          {passwordRefused && problem !== null ? (
            <Note tone="warn">{passwordProblemText(problem)}</Note>
          ) : null}
          {passwordsMismatch ? <Note tone="error">{t("onb.mismatch")}</Note> : null}
          <Note boxed>{t("onb.passwordNote")}</Note>
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
