import type { ReactNode } from "react";
import { getAddress } from "viem";
import { t } from "../../core/i18n";
import { shortenAddress } from "../../core/lib/format";
import type { RecentRecipient, RecipientRisk } from "../lib/recipients";
import { Identicon } from "./Identicon";
import { Note } from "./kit";

/** How many recent recipients the row under the field offers; the store keeps more. */
const OFFERED = 3;

/** Tappable recent recipients under an empty recipient field. A tap only fills it. */
export function RecentRecipients({
  known,
  disabled,
  onPick,
}: {
  known: readonly RecentRecipient[] | null;
  disabled?: boolean;
  onPick: (address: string) => void;
}): ReactNode {
  if (known === null || known.length === 0) return null;
  return (
    <div className="w-recents" role="group" aria-label={t("send.recent")}>
      <span className="w-recents-label">{t("send.recent")}</span>
      {known.slice(0, OFFERED).map((entry) => {
        const address = getAddress(entry.address);
        return (
          <button
            key={entry.address}
            type="button"
            className="w-recent"
            title={address}
            aria-label={entry.name === undefined ? undefined : `${entry.name} ${address}`}
            disabled={disabled}
            onClick={() => onPick(address)}
          >
            <Identicon address={address} size={12} />
            {entry.name ?? shortenAddress(address)}
          </button>
        );
      })}
    </div>
  );
}

/** The never-used and look-alike warnings. They inform; nothing is blocked. */
export function RecipientWarning({ risk }: { risk: RecipientRisk | null }): ReactNode {
  if (risk === "lookalike") return <Note tone="error">{t("send.lookalike")}</Note>;
  if (risk === "new") return <Note tone="warn">{t("send.firstTime")}</Note>;
  return null;
}
