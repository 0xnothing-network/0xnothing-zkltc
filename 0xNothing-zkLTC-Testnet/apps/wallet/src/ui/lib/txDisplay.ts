import type { MessageKey } from "../../core/i18n";
import type { TxKind, TxRecord } from "../../core/services/history";
import type { IconName, Tone } from "../components/kit";

/**
 * How a History row is drawn: its glyph and its status pill. Shared by the
 * History screen and Home's pending rows, which must read the same; it lives
 * here because History is a lazy chunk that Home may not pull in.
 */
export const KIND_ICON: Record<TxKind, IconName> = {
  send: "send",
  "mint-nusd": "plus",
  "redeem-nusd": "receive",
  supply: "send",
  withdraw: "receive",
  "points-stake": "lock",
  "points-withdraw": "receive",
  "points-claim": "checkCircle",
  swap: "trade",
  approve: "checkCircle",
  nft: "dapp",
  dapp: "external",
};

export const TX_STATUS: Record<TxRecord["status"], { label: MessageKey; tone: Tone }> = {
  pending: { label: "status.pending", tone: "warn" },
  success: { label: "status.success", tone: "ok" },
  failed: { label: "status.failed", tone: "bad" },
  dropped: { label: "status.dropped", tone: "dim" },
};
