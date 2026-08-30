import { type ReactNode, useState } from "react";
import { t } from "../../../core/i18n";
import { describeError } from "../../../core/lib/errors";
import { wipeWallet } from "../../../core/keyring/vault";
import { Button, Note, Panel, PanelBody } from "../../components/kit";

/**
 * Wiping the wallet. The confirmation has to be typed because there is no
 * recovery path here: the vault, the accounts, the imported tokens and the local
 * history all go, and only the seed phrase can bring the accounts back.
 *
 * The confirmation word is translated with the rest of the panel, so it is
 * compared case-insensitively rather than against one fixed spelling.
 *
 * The page is reloaded afterwards rather than transitioned in place — that way
 * every cached read in every mounted screen goes with it, and the app comes back
 * up at onboarding because there is no longer a vault to unlock.
 */
export function DangerZone(): ReactNode {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const confirmWord = t("wipe.word");

  const ready = typed.trim().toUpperCase() === confirmWord.toUpperCase();

  const wipe = async (): Promise<void> => {
    if (busy || !ready) return;
    setBusy(true);
    setError(null);
    try {
      await wipeWallet();
      window.location.reload();
    } catch (cause) {
      setError(describeError(cause));
      setBusy(false);
    }
  };

  return (
    <Panel title={t("danger.panel")}>
      <PanelBody>
        {!open ? (
          <>
            <Button
              variant="danger"
              block
              onClick={() => {
                setTyped("");
                setError(null);
                setOpen(true);
              }}
            >
              {t("wipe.action")}
            </Button>
            <Note>{t("danger.note")}</Note>
          </>
        ) : (
          <>
            <label className="w-field">
              <span className="w-label">{t("wipe.typeLabel", { word: confirmWord })}</span>
              <input
                className="w-input"
                value={typed}
                autoFocus
                disabled={busy}
                spellCheck={false}
                autoComplete="off"
                aria-invalid={typed.length > 0 && !ready}
                onChange={(event) => {
                  setTyped(event.target.value);
                  setError(null);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && ready) void wipe();
                }}
              />
            </label>
            <Note tone="warn">{t("danger.warning")}</Note>
            {error !== null ? (
              <div role="alert">
                <Note tone="error">{error}</Note>
              </div>
            ) : null}
            <div className="w-btn-row">
              <Button
                block
                disabled={busy}
                onClick={() => {
                  setOpen(false);
                  setTyped("");
                  setError(null);
                }}
              >
                {t("common.cancel")}
              </Button>
              <Button
                variant="danger"
                block
                disabled={busy || !ready}
                onClick={() => void wipe()}
              >
                {busy ? t("danger.deleting") : t("danger.forever")}
              </Button>
            </div>
          </>
        )}
      </PanelBody>
    </Panel>
  );
}
