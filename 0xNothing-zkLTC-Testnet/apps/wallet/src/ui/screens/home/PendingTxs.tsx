import { type ReactNode, useEffect, useState } from "react";
import { txUrl } from "../../../config/chain";
import { t } from "../../../core/i18n";
import { openExternal } from "../../../core/platform/env";
import { listWatched, recordSummary } from "../../../core/services/history";
import { Icon, Pill } from "../../components/kit";
import { useLiveRead } from "../../hooks/useLiveRead";
import { EMPTY_WATCH, pendingRows, type PendingWatch, trackPending } from "../../lib/pendingRows";
import { KIND_ICON, TX_STATUS } from "../../lib/txDisplay";
import { useWallet } from "../../state/WalletContext";

/**
 * The wallet's own transactions still in flight, above the tabs. The read is
 * local storage on each block; the node is asked only while a row is pending
 * (listWatched), and a row settles here in place.
 */
export function PendingTxs(): ReactNode {
  const { address, network, tick } = useWallet();
  const read = useLiveRead(address ? () => listWatched(address, network) : null, [address, network.id, tick], {
    identity: [address, network.id],
  });
  const [watch, setWatch] = useState<PendingWatch>(EMPTY_WATCH);

  useEffect(() => {
    setWatch(EMPTY_WATCH);
  }, [address, network.id]);

  // Runs on each read, which comes with every block, so a settled row's minute
  // is checked without a timer of its own.
  useEffect(() => {
    if (read.data) setWatch((prev) => trackPending(prev, read.data ?? [], Date.now()));
  }, [read.data]);

  const rows = pendingRows(read.data ?? [], watch.hashes);
  if (rows.length === 0) return null;
  return (
    <div className="w-list w-home-pending" role="group" aria-label={t("home.pendingAria")}>
      {rows.map((row) => (
        <button
          key={row.hash}
          type="button"
          className="w-tx"
          data-status={row.status}
          aria-label={`${recordSummary(row)} · ${t(TX_STATUS[row.status].label)}`}
          onClick={() => {
            const url = txUrl(row.hash, network);
            if (url) void openExternal(url);
          }}
        >
          <span className="w-tx-glyph" aria-hidden="true">
            <Icon name={row.status === "failed" ? "close" : KIND_ICON[row.kind]} size={14} />
          </span>
          <span className="w-tx-main">
            <span className="w-tx-summary">{recordSummary(row)}</span>
          </span>
          <span className="w-tx-side">
            <Pill tone={TX_STATUS[row.status].tone}>{t(TX_STATUS[row.status].label)}</Pill>
          </span>
        </button>
      ))}
    </div>
  );
}
