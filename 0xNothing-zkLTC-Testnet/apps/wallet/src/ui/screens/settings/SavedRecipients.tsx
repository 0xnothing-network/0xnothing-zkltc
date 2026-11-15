import { type ReactNode, useState } from "react";
import { getAddress } from "viem";
import { chainScope } from "../../../config/networks";
import { t } from "../../../core/i18n";
import { describeError } from "../../../core/lib/errors";
import { shortenAddress } from "../../../core/lib/format";
import { Button, Note, Panel, PanelBody } from "../../components/kit";
import { useActionGate } from "../../hooks/useActionGate";
import { useLiveRead } from "../../hooks/useLiveRead";
import {
  cleanRecipientName,
  forgetRecipient,
  MAX_RECIPIENT_NAME,
  type RecentRecipient,
  recentRecipients,
  renameRecipient,
} from "../../lib/recipients";
import { useWallet } from "../../state/WalletContext";

/**
 * Saved recipients of the active account on the active chain: the list Send
 * fills by itself, where an entry can be named or removed. A name is a local
 * label; the never-used and look-alike checks keep judging the address.
 */
export function SavedRecipients(): ReactNode {
  const { address, network, notify } = useWallet();
  const scope = chainScope(network.id);
  const read = useLiveRead(address ? () => recentRecipients(address, scope) : null, [address, scope], {
    live: false,
  });
  const [busy, setBusy] = useState<string | null>(null);
  const actionGate = useActionGate();
  const [error, setError] = useState<string | null>(null);
  const list = read.data ?? [];

  const run = async (key: string, task: () => Promise<void>, done?: string): Promise<void> => {
    if (busy !== null || !actionGate.tryEnter()) return;
    setBusy(key);
    setError(null);
    try {
      await task();
      read.reload();
      if (done) notify(done, "ok");
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      actionGate.leave();
      setBusy(null);
    }
  };

  return (
    <Panel title={t("rcp.panel")}>
      <PanelBody>
        {list.length === 0 ? (
          <Note>{read.error ?? t("rcp.empty")}</Note>
        ) : (
          list.map((entry) => (
            <SavedRecipientRow
              key={entry.address}
              entry={entry}
              busy={busy}
              onSave={(name) => {
                if (address) void run(`name:${entry.address}`, () => renameRecipient(address, scope, entry.address, name), t("rcp.saved"));
              }}
              onRemove={() => {
                if (address) void run(`remove:${entry.address}`, () => forgetRecipient(address, scope, entry.address));
              }}
            />
          ))
        )}
        {error !== null ? (
          <div role="alert">
            <Note tone="error">{error}</Note>
          </div>
        ) : null}
        <Note>{t("rcp.note")}</Note>
      </PanelBody>
    </Panel>
  );
}

function SavedRecipientRow({
  entry,
  busy,
  onSave,
  onRemove,
}: {
  entry: RecentRecipient;
  busy: string | null;
  onSave: (name: string) => void;
  onRemove: () => void;
}): ReactNode {
  const [input, setInput] = useState(entry.name ?? "");
  const checksum = getAddress(entry.address);
  // Blank clears the name; anything else must clean to a valid name.
  const invalid = input.trim().length > 0 && cleanRecipientName(input) === null;
  const unchanged = (cleanRecipientName(input) ?? "") === (entry.name ?? "");
  const inputId = `rcp-name-${entry.address}`;
  return (
    <div className="w-set-form">
      <div className="w-split">
        <span className="w-asset-main">
          <span className="w-asset-symbol" title={checksum}>{shortenAddress(checksum)}</span>
          {entry.name !== undefined ? <span className="w-asset-sub">{entry.name}</span> : null}
        </span>
        <Button size="sm" variant="danger" disabled={busy !== null} onClick={onRemove}>
          {busy === `remove:${entry.address}` ? t("common.working") : t("common.remove")}
        </Button>
      </div>
      <div className="w-split w-rcp-name">
        <label className="w-field" htmlFor={inputId}>
          <span className="w-label">{t("rcp.nameLabel")}</span>
          <input
            id={inputId}
            className="w-input"
            value={input}
            maxLength={MAX_RECIPIENT_NAME * 2}
            spellCheck={false}
            autoComplete="off"
            placeholder={t("rcp.namePlaceholder")}
            disabled={busy !== null}
            aria-invalid={invalid}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !invalid && !unchanged) onSave(input);
            }}
          />
        </label>
        <Button size="sm" disabled={busy !== null || invalid || unchanged} onClick={() => onSave(input)}>
          {busy === `name:${entry.address}` ? t("common.working") : t("rcp.save")}
        </Button>
      </div>
      {invalid ? <Note tone="error">{t("rcp.badName")}</Note> : null}
    </div>
  );
}
