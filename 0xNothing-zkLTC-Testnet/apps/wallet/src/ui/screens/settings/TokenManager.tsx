import { type ReactNode, useState } from "react";
import { isAddress } from "viem";
import { t } from "../../../core/i18n";
import { describeError } from "../../../core/lib/errors";
import { shortenAddress } from "../../../core/lib/format";
import { addCustomToken, lookupToken, removeCustomToken } from "../../../core/services/tokens";
import { Button, Note, Panel, PanelBody, Row, Rows } from "../../components/kit";
import { useActionGate } from "../../hooks/useActionGate";
import { useLiveRead } from "../../hooks/useLiveRead";
import { useWallet } from "../../state/WalletContext";

/**
 * Imported tokens. Symbol, name and decimals are read from the contract, never
 * typed in, so a token cannot appear in the list under a symbol it does not
 * have — the preview below the field is that same on-chain read.
 */
export function TokenManager(): ReactNode {
  const { network, tokens, reload, notify } = useWallet();
  const [adding, setAdding] = useState(false);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const actionGate = useActionGate();
  const [error, setError] = useState<string | null>(null);

  const trimmed = input.trim();
  const valid = isAddress(trimmed);
  const custom = tokens.filter((token) => !token.builtin);
  const preview = useLiveRead(
    valid ? () => lookupToken(trimmed, network) : null,
    [trimmed, valid, network.id],
    {
      live: false,
    },
  );

  const add = async (): Promise<void> => {
    const candidate = input.trim();
    if (
      busy !== null
      || !isAddress(candidate)
      || preview.data === null
      || preview.loading
      || !actionGate.tryEnter()
    ) return;
    setBusy("add");
    setError(null);
    try {
      await addCustomToken(candidate);
      setInput("");
      await reload();
      setAdding(false);
      notify(t("tok.done"), "ok");
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      actionGate.leave();
      setBusy(null);
    }
  };

  const remove = async (id: string): Promise<void> => {
    if (busy !== null || !actionGate.tryEnter()) return;
    setBusy(id);
    setError(null);
    try {
      await removeCustomToken(id);
      await reload();
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      actionGate.leave();
      setBusy(null);
    }
  };

  const closeAdd = (): void => {
    setAdding(false);
    setInput("");
    setError(null);
  };

  return (
    <Panel title={t("tok.panel")}>
      <PanelBody>
        {adding ? (
          <>
            <label className="w-field">
              <span className="w-label">{t("tok.addressLabel")}</span>
              <input
                className="w-input"
                value={input}
                autoFocus
                spellCheck={false}
                autoComplete="off"
                placeholder="0x…"
                disabled={busy !== null}
                aria-invalid={trimmed.length > 0 && !valid}
                onChange={(event) => {
                  setInput(event.target.value);
                  setError(null);
                }}
                onKeyDown={(event) => {
                  if (
                    event.key === "Enter"
                    && valid
                    && preview.data !== null
                    && !preview.loading
                  ) {
                    void add();
                  }
                }}
              />
            </label>
            {trimmed.length > 0 && !valid ? (
              <Note tone="error">{t("send.badAddress")}</Note>
            ) : null}
            {valid && preview.loading ? <Note>{t("common.working")}</Note> : null}
            {preview.data !== null ? (
              <Rows>
                <Row label={t("tok.symbol")} value={preview.data.symbol} tone="green" />
                <Row label={t("tok.name")} value={preview.data.name} />
                <Row label={t("tok.decimals")} value={preview.data.decimals.toString()} />
              </Rows>
            ) : null}
            {preview.error !== null ? <Note tone="warn">{preview.error}</Note> : null}
            <div className="w-btn-row">
              <Button block disabled={busy !== null} onClick={closeAdd}>
                {t("common.cancel")}
              </Button>
              <Button
                variant="primary"
                block
                disabled={busy !== null || !valid || preview.data === null || preview.loading}
                onClick={() => void add()}
              >
                {busy === "add" ? t("tok.adding") : t("tok.add")}
              </Button>
            </div>
            <Note>{t("tok.note")}</Note>
          </>
        ) : (
          <Button
            variant="primary"
            block
            disabled={busy !== null}
            onClick={() => {
              setError(null);
              setAdding(true);
            }}
          >
            {t("tok.add")}
          </Button>
        )}
        {error !== null ? (
          <div role="alert">
            <Note tone="error">{error}</Note>
          </div>
        ) : null}
        {custom.length === 0 ? (
          <Note>{t("tok.empty")}</Note>
        ) : (
          custom.map((token) => (
            <div key={token.id} className="w-split">
              <span className="w-asset-main">
                <span className="w-asset-symbol">{token.symbol}</span>
                <span className="w-asset-sub">
                  {token.name} · {shortenAddress(token.id)}
                </span>
              </span>
              <Button
                size="sm"
                variant="danger"
                disabled={busy !== null}
                onClick={() => void remove(token.id)}
              >
                {busy === token.id ? t("common.working") : t("common.remove")}
              </Button>
            </div>
          ))
        )}
      </PanelBody>
    </Panel>
  );
}
