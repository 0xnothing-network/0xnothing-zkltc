import { type ReactNode, useState } from "react";
import { txUrl } from "../../config/chain";
import { type MessageKey, t } from "../../core/i18n";
import { describeError } from "../../core/lib/errors";
import { formatClock, formatTimeAgo, shortenAddress } from "../../core/lib/format";
import { openExternal } from "../../core/platform/env";
import {
  clearRecords,
  listSettled,
  recordDetail,
  recordSummary,
  type TxKind,
  type TxRecord,
} from "../../core/services/history";
import { Button, Empty, Note, Pill, type Tone } from "../components/kit";
import { Screen } from "../components/Screen";
import { useLiveRead } from "../hooks/useLiveRead";
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
  swap: "kind.swap",
  approve: "kind.approve",
  nft: "kind.nft",
  dapp: "kind.dapp",
};

const STATUS: Record<TxRecord["status"], { label: MessageKey; tone: Tone }> = {
  pending: { label: "status.pending", tone: "warn" },
  success: { label: "status.success", tone: "ok" },
  failed: { label: "status.failed", tone: "bad" },
};

export function History(): ReactNode {
  const { address, network, tick } = useWallet();
  const read = useLiveRead(address ? () => listSettled(address, network) : null, [address, network.id, tick], {
    identity: [address, network.id],
  });
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const rows = read.data ?? [];

  const clear = async (): Promise<void> => {
    if (busy || !address) return;
    setBusy(true);
    setActionError(null);
    try {
      await clearRecords(address);
      read.reload();
    } catch (cause) {
      setActionError(describeError(cause));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Screen
      title={t("hist.title")}
      onBack={goHome}
      right={
        rows.length > 0 ? (
          <Button size="sm" disabled={busy || read.busy} onClick={() => void clear()}>
            {busy ? t("common.working") : t("hist.clear")}
          </Button>
        ) : undefined
      }
    >
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
              aria-label={`${recordSummary(row)} · ${t(STATUS[row.status].label)} · ${formatTimeAgo(row.at)}`}
              onClick={() => {
                const url = txUrl(row.hash, network);
                if (url) void openExternal(url);
              }}
            >
              <span className="w-tx-main">
                <span className="w-tx-summary">{recordSummary(row)}</span>
                <span className="w-tx-detail">
                  {t(KIND_LABEL[row.kind])} ·{" "}
                  {recordDetail(row) ?? shortenAddress(row.hash, 10, 6)}
                </span>
              </span>
              <span className="w-tx-side">
                <Pill tone={STATUS[row.status].tone}>{t(STATUS[row.status].label)}</Pill>
                <span className="w-tx-detail" title={formatClock(row.at)}>
                  {formatTimeAgo(row.at)}
                </span>
              </span>
            </button>
          ))}
        </div>
      )}
      <div className="w-stack">
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
    </Screen>
  );
}
