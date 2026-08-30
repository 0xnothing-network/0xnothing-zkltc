import type { Address, Hex } from "viem";
import { type MessageKey, t, type TParams } from "../i18n";
import { LITVM_NETWORK, type WalletNetwork } from "../../config/networks";
import { persistentStore } from "../platform/storage";
import { STORAGE_KEYS } from "../platform/storageKeys";
import { withNamedLock } from "../platform/locks";
import { activeNetwork, publicClient } from "../rpc/client";

/**
 * Local transaction log.
 *
 * The chain offers no per-account transaction index and the wallet has no
 * indexer of its own, so the history lists what this wallet itself submitted,
 * plus a link to the explorer for the authoritative view. Transfers received
 * while the wallet was closed are not listed — the screen says so rather than
 * pretending the list is complete.
 */
export type TxKind =
  | "send"
  | "mint-nusd"
  | "redeem-nusd"
  | "supply"
  | "withdraw"
  | "swap"
  | "approve"
  | "nft"
  | "dapp";

export type TxStatus = "pending" | "success" | "failed";

/**
 * A stored line, kept as a catalog key plus its parameters rather than as
 * finished text: the log outlives any one language, so a row written in English
 * still reads in Chinese after the user switches.
 */
export interface TxLabel {
  key: MessageKey;
  params?: TParams;
}

export interface TxRecord {
  hash: Hex;
  account: Address;
  /** Network profile that accepted the transaction; old rows default to LitVM. */
  networkId?: string;
  kind: TxKind;
  status: TxStatus;
  at: number;
  /** The main line, rendered at display time. */
  label?: TxLabel;
  /** Second line when it is data — an address, a route, an amount. */
  detail?: string;
  /** Second line when it is prose. */
  detailLabel?: TxLabel;
  /** Rows written before the wallet spoke more than one language. */
  summary?: string;
}

/** The main line of a row in the language on screen now. */
export function recordSummary(record: TxRecord): string {
  if (record.label) return t(record.label.key, record.label.params);
  return record.summary ?? "";
}

export function recordDetail(record: TxRecord): string | undefined {
  if (record.detailLabel) return t(record.detailLabel.key, record.detailLabel.params);
  return record.detail;
}

type HistoryBook = Record<string, TxRecord[]>;

const KEEP_PER_ACCOUNT = 200;
const HISTORY_LOCK = `history:${STORAGE_KEYS.history}`;

async function readBook(): Promise<HistoryBook> {
  return (await persistentStore.get<HistoryBook>(STORAGE_KEYS.history)) ?? {};
}

export async function listRecords(
  account: Address,
  network: WalletNetwork = activeNetwork,
): Promise<TxRecord[]> {
  const book = await readBook();
  return (book[account.toLowerCase()] ?? []).filter(
    (entry) => (entry.networkId ?? LITVM_NETWORK.id) === network.id,
  );
}

export async function addRecord(record: TxRecord): Promise<void> {
  await withNamedLock(HISTORY_LOCK, async () => {
    const book = await readBook();
    const key = record.account.toLowerCase();
    const existing = book[key] ?? [];
    const next = [record, ...existing.filter((entry) => entry.hash !== record.hash)].slice(
      0,
      KEEP_PER_ACCOUNT,
    );
    await persistentStore.set(STORAGE_KEYS.history, { ...book, [key]: next });
  });
}

export async function setRecordStatus(
  account: Address,
  hash: Hex,
  status: TxStatus,
  networkId = activeNetwork.id,
): Promise<void> {
  await withNamedLock(HISTORY_LOCK, async () => {
    const book = await readBook();
    const key = account.toLowerCase();
    const existing = book[key];
    if (!existing) return;
    await persistentStore.set(STORAGE_KEYS.history, {
      ...book,
      [key]: existing.map((entry) => (
        entry.hash === hash
          && (entry.networkId ?? LITVM_NETWORK.id) === networkId
          ? { ...entry, status }
          : entry
      )),
    });
  });
}

export async function clearRecords(account: Address): Promise<void> {
  await withNamedLock(HISTORY_LOCK, async () => {
    const book = await readBook();
    const next = { ...book };
    delete next[account.toLowerCase()];
    await persistentStore.set(STORAGE_KEYS.history, next);
  });
}

/**
 * Lists an account's records, first settling any row still marked "pending".
 *
 * `afterSubmit` in tx.ts only awaits the receipt for as long as the page lives,
 * so a popup closed too early leaves a row pending forever. There is no
 * background watcher to fix that, which makes the screen that displays the row
 * the right place to ask the node once — and it costs one receipt lookup per
 * unsettled hash, normally zero.
 */
export async function listSettled(
  account: Address,
  network: WalletNetwork = activeNetwork,
): Promise<TxRecord[]> {
  const records = await listRecords(account, network);
  const unsettled = records.filter((entry) => entry.status === "pending");
  if (unsettled.length === 0) return records;

  // Keep the RPC client paired with the profile used to select the rows. A
  // settings change while receipts are loading must not settle against a
  // different chain.
  const client = publicClient;

  const settled = await Promise.all(
    unsettled.map(async (entry) => {
      const receipt = await client
        .getTransactionReceipt({ hash: entry.hash })
        .catch(() => null);
      if (!receipt) return null;
      const status: TxStatus = receipt.status === "success" ? "success" : "failed";
      return { hash: entry.hash, status };
    }),
  );

  const patched = new Map<Hex, TxStatus>(
    settled.flatMap((entry) => (entry ? [[entry.hash, entry.status] as const] : [])),
  );
  if (patched.size > 0) {
    await withNamedLock(HISTORY_LOCK, async () => {
      const book = await readBook();
      const key = account.toLowerCase();
      const current = book[key] ?? [];
      await persistentStore.set(STORAGE_KEYS.history, {
        ...book,
        [key]: current.map((entry) => {
          const status = patched.get(entry.hash);
          return status === undefined
            || (entry.networkId ?? LITVM_NETWORK.id) !== network.id
            ? entry
            : { ...entry, status };
        }),
      });
    });
  }
  return records.map((entry) => {
    const status = patched.get(entry.hash);
    return status === undefined ? entry : { ...entry, status };
  });
}
