import { type ReactNode, useEffect, useState } from "react";
import { txUrl } from "../../config/chain";
import { type MessageKey, t } from "../../core/i18n";
import { describeError } from "../../core/lib/errors";
import { formatClock, formatTimeAgo, shortenAddress } from "../../core/lib/format";
import { isExtension, openExternal } from "../../core/platform/env";
import {
  clearRecords,
  listSettled,
  recordDetail,
  recordSummary,
  type TxKind,
  type TxRecord,
} from "../../core/services/history";
import { Button, Empty, Icon, Note, Pill } from "../components/kit";
import { Screen } from "../components/Screen";
import { useActionGate } from "../hooks/useActionGate";
import { useLiveRead } from "../hooks/useLiveRead";
import { useRecipients } from "../hooks/useRecipients";
import { type RecentRecipient, recipientName } from "../lib/recipients";
import { downloadCsv, historyCsv, historyFileName } from "../lib/historyCsv";
import { CONFIRM_TAP_MS, secondTapFires } from "../lib/twoStep";
import { KIND_ICON, TX_STATUS } from "../lib/txDisplay";
import { goHome } from "../router";
import { useWallet } from "../state/WalletContext";

/**
 * HISTORY. The chain has no per-account index and this wallet ships no indexer,
 * so the list is what this wallet itself sent — and the screen says so instead
 * of letting the user read an incomplete list as a complete one.
 */
const KIND_LABEL: Record<TxKind, MessageKey> = {
  send: "kind.send",
  "mint-nusd": "kind.mintNusd",
  "redeem-nusd": "kind.redeemNusd",
  supply: "kind.supply",
  withdraw: "kind.withdraw",
  "points-stake": "kind.pointsStake",
  "points-withdraw": "kind.pointsWithdraw",
  "points-claim": "kind.pointsClaim",
  swap: "kind.swap",
  approve: "kind.approve",
  nft: "kind.nft",
  dapp: "kind.dapp",
};

/**
 * The detail line of a row: a send's recipient carries the name the user gave
 * it on this chain, beside the short address that the name never replaces.
 */
function rowDetail(row: TxRecord, known: readonly RecentRecipient[] | null): string {
  const detail = recordDetail(row);
  if (detail === undefined) return shortenAddress(row.hash, 10, 6);
  const name = row.kind === "send" || row.kind === "nft" ? recipientName(known, detail) : null;
  return name === null ? detail : `${name} · ${shortenAddress(detail)}`;
}

export function History(): ReactNode {
  const { address, network, tick } = useWallet();
  const read = useLiveRead(address ? () => listSettled(address, network) : null, [address, network.id, tick], {
    identity: [address, network.id],
  });
  const known = useRecipients(address, network);
  const [busy, setBusy] = useState(false);
  const actionGate = useActionGate();
  const [actionError, setActionError] = useState<string | null>(null);
  // Clear wipes this network's settled rows with no undo, so it takes two taps.
  const [clearArmedAt, setClearArmedAt] = useState<number | null>(null);
  useEffect(() => {
    if (clearArmedAt === null) return;
    const id = setTimeout(() => setClearArmedAt(null), CONFIRM_TAP_MS);
    return () => clearTimeout(id);
  }, [clearArmedAt]);
  const tapClear = (): void => {
    const now = Date.now();
    if (!secondTapFires(clearArmedAt, now)) {
      // A too-quick second touch keeps the first arming; anything else re-arms.
      if (clearArmedAt === null || now - clearArmedAt > CONFIRM_TAP_MS) setClearArmedAt(now);
      return;
    }
    setClearArmedAt(null);
    void clear();
  };
  const rows = read.data ?? [];

  // Exactly the rows on screen, in their order and in the language on screen.
  const exportCsv = (): void => {
    const now = Date.now();
    const text = historyCsv(
      [t("hist.csvDate"), t("hist.csvKind"), t("hist.csvSummary"), t("hist.csvStatus"), t("hist.csvHash"), t("common.network")],
      rows.map((row) => {
        const detail = recordDetail(row);
        return [
          new Date(row.at).toISOString(),
          t(KIND_LABEL[row.kind]),
          detail === undefined ? recordSummary(row) : `${recordSummary(row)} · ${detail}`,
          t(TX_STATUS[row.status].label),
          row.hash,
          network.name,
        ];
      }),
    );
    downloadCsv(historyFileName(network.chainId, now), text);
  };

  const clear = async (): Promise<void> => {
    if (busy || !address || !actionGate.tryEnter()) return;
    setBusy(true);
    setActionError(null);
    try {
      await clearRecords(address, network);
      read.reload();
    } catch (cause) {
      setActionError(describeError(cause));
    } finally {
      actionGate.leave();
      setBusy(false);
    }
  };
  return (
    <Screen
      title={t("hist.title")}
      onBack={goHome}
      right={
        rows.length > 0 ? (
          <span className="w-hist-actions">
            {/* Android's WebView does nothing with a download link, so it is not offered there. */}
            {isExtension ? (
              <Button variant="ghost" size="sm" aria-label={t("hist.exportAria")} onClick={exportCsv}>
                {t("hist.export")}
              </Button>
            ) : null}
            <Button variant="ghost" size="sm" disabled={busy || read.busy} onClick={tapClear}>
              {busy ? t("common.working") : clearArmedAt !== null ? t("hist.clearConfirm") : t("hist.clear")}
            </Button>
          </span>
        ) : undefined
      }
    >
      <div className="w-hist">
        {rows.length === 0 ? (
          read.error !== null ? (
            <div className="w-stack" role="alert">
              <Note tone="error">{read.error}</Note>
            </div>
          ) : (
            <Empty>{read.loading ? t("hist.loading") : t("hist.empty")}</Empty>
          )
        ) : (
          <div className="w-list" aria-busy={read.busy || busy}>
            {rows.map((row) => (
              <button
                key={row.hash}
                type="button"
                className="w-tx"
                data-status={row.status}
                aria-label={`${recordSummary(row)} · ${t(TX_STATUS[row.status].label)} · ${formatTimeAgo(row.at)}`}
                onClick={() => {
                  const url = txUrl(row.hash, network);
                  if (url) void openExternal(url);
                }}
              >
                <span className="w-tx-glyph" aria-hidden="true">
                  <Icon name={row.status === "failed" ? "close" : KIND_ICON[row.kind]} size={16} />
                </span>
                <span className="w-tx-main">
                  <span className="w-tx-summary">{recordSummary(row)}</span>
                  {/* The time closes the detail line and never truncates; the
                      detail before it gives way first. */}
                  <span className="w-tx-detail">
                    <span className="w-tx-what">
                      {t(KIND_LABEL[row.kind])} ·{" "}
                      {rowDetail(row, known)}
                    </span>
                    <span className="w-tx-when" title={formatClock(row.at)}>
                      · {formatTimeAgo(row.at)}
                    </span>
                  </span>
                </span>
                <span className="w-tx-side">
                  <Pill tone={TX_STATUS[row.status].tone}>{t(TX_STATUS[row.status].label)}</Pill>
                </span>
              </button>
            ))}
          </div>
        )}
        <div className="w-stack w-hist-foot">
          {read.error !== null && rows.length > 0 ? (
            <div role="alert">
              <Note tone="error">{read.error}</Note>
            </div>
          ) : null}
          {actionError !== null ? (
            <div role="alert">
              <Note tone="error">{actionError}</Note>
            </div>
          ) : null}
          <Note>{t("hist.note")}</Note>
        </div>
      </div>
    </Screen>
  );
}
