import { type ReactNode, useId, useState } from "react";
import { t } from "../../../core/i18n";
import { describeError } from "../../../core/lib/errors";
import { wipeWallet } from "../../../core/keyring/vault";
import { Button, Icon, Note, Panel, PanelBody } from "../../components/kit";
import { useActionGate } from "../../hooks/useActionGate";
import { releaseCustomRpcPermissions, releaseNotificationsBeforeErase } from "./rpcRelease";

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
  const actionGate = useActionGate();
  const [error, setError] = useState<string | null>(null);
  const errorId = useId();
  const confirmWord = t("wipe.word");

  const ready = typed.trim().toUpperCase() === confirmWord.toUpperCase();

  const wipe = async (): Promise<void> => {
    if (busy || !ready || !actionGate.tryEnter()) return;
    setBusy(true);
    setError(null);
    try {
      // The custom RPC host grants go first, while the profiles naming them
      // can still be read; this never throws. So does the notifications release.
      await releaseNotificationsBeforeErase();
      await releaseCustomRpcPermissions();
      await wipeWallet();
      window.location.reload();
    } catch (cause) {
      setError(describeError(cause));
      actionGate.leave();
      setBusy(false);
    }
  };

  return (
    <Panel title={t("danger.panel")} tone="danger">
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
              <Icon name="trash" size={16} />
            </Button>
            <Note>{t("danger.note")}</Note>
          </>
        ) : (
          <div className="w-set-form">
            <label className="w-field">
              <span className="w-label">{t("wipe.typeLabel", { word: confirmWord })}</span>
              <input
                className="w-input"
                value={typed}
                autoFocus
                readOnly={busy}
                spellCheck={false}
                autoComplete="off"
                aria-invalid={typed.length > 0 && !ready}
                aria-describedby={error !== null ? errorId : undefined}
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
              <div role="alert" id={errorId}>
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
          </div>
        )}
      </PanelBody>
    </Panel>
  );
}
