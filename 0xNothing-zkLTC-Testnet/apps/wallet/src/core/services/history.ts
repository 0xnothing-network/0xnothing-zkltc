import type { Address, Hex } from "viem";
import { type MessageKey, t, type TParams } from "../i18n";
import { LITVM_NETWORK, onNetworkChain, type WalletNetwork } from "../../config/networks";
import { persistentStore } from "../platform/storage";
import { STORAGE_KEYS } from "../platform/storageKeys";
import { withNamedLock } from "../platform/locks";
import { activeNetwork, publicClientFor } from "../rpc/client";

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
  | "points-stake"
  | "points-withdraw"
  | "points-claim"
  | "swap"
  | "approve"
  | "nft"
  | "dapp";

/**
 * `dropped` is a transaction that can no longer be mined: the node does not know
 * it and the account's mined nonce has moved past the one it was signed with.
 * It is not final: those two reads can reach different nodes behind one
 * endpoint, so listSettled keeps asking for a receipt and a late one wins.
 */
export type TxStatus = "pending" | "success" | "failed" | "dropped";

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
  /** The nonce it was signed with; older rows have none. */
  nonce?: number;
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

const TX_KINDS: ReadonlySet<string> = new Set<TxKind>([
  "send",
  "mint-nusd",
  "redeem-nusd",
  "supply",
  "withdraw",
  "points-stake",
  "points-withdraw",
  "points-claim",
  "swap",
  "approve",
  "nft",
  "dapp",
]);

export async function listRecords(
  account: Address,
  network: WalletNetwork = activeNetwork,
): Promise<TxRecord[]> {
  const book = await readBook();
  // Rows written for features the wallet no longer has are kept in storage but not shown.
  return (book[account.toLowerCase()] ?? []).filter(
    (entry) => onNetworkChain(entry.networkId, network.id) && TX_KINDS.has(entry.kind),
  );
}

export async function addRecord(record: TxRecord): Promise<void> {
  await withNamedLock(HISTORY_LOCK, async () => {
    const book = await readBook();
    const key = record.account.toLowerCase();
    const existing = book[key] ?? [];
    const networkId = record.networkId ?? LITVM_NETWORK.id;
    const next = [record, ...existing.filter((entry) => (
      entry.hash !== record.hash || !onNetworkChain(entry.networkId, networkId)
    ))].slice(
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
          && onNetworkChain(entry.networkId, networkId)
          ? { ...entry, status }
          : entry
      )),
    });
  });
}

/**
 * Clears what the History screen shows: the account's rows on one network.
 * Other networks' rows stay, and so do pending rows, which are the only record
 * of a transaction that may still land and are settled only by listSettled.
 */
export async function clearRecords(
  account: Address,
  network: WalletNetwork = activeNetwork,
): Promise<void> {
  await withNamedLock(HISTORY_LOCK, async () => {
    const book = await readBook();
    const key = account.toLowerCase();
    const kept = (book[key] ?? []).filter((entry) => (
      !onNetworkChain(entry.networkId, network.id) || entry.status === "pending"
    ));
    const next = { ...book };
    if (kept.length > 0) next[key] = kept;
    else delete next[key];
    await persistentStore.set(STORAGE_KEYS.history, next);
  });
}

/**
 * Whether a pending row can no longer be mined. Only a definite answer counts:
 * the account's mined nonce has passed the row's nonce (read first, so a
 * transaction mined between the two reads is still found) and the node then
 * reports no such transaction. Rows without a nonce, and any failed read, stay
 * pending: the wallet does not know.
 */
async function wasDropped(
  client: ReturnType<typeof publicClientFor>,
  entry: TxRecord,
): Promise<boolean> {
  if (typeof entry.nonce !== "number") return false;
  try {
    const mined = await client.getTransactionCount({ address: entry.account, blockTag: "latest" });
    if (mined <= entry.nonce) return false;
    await client.getTransaction({ hash: entry.hash });
    return false;
  } catch (error) {
    return (error as { name?: unknown } | null)?.name === "TransactionNotFoundError";
  }
}

/**
 * Lists an account's records, first settling any row still marked "pending"
 * or "dropped".
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
  // Capture before storage yields, including explicitly requested profiles.
  const client = publicClientFor(network);
  const records = await listRecords(account, network);
  // A "dropped" row is asked again too: the drop rests on two reads that a
  // load-balanced endpoint may answer from nodes at different heights, and a
  // mined transaction shown as dropped for good invites a duplicate send.
  const unsettled = records.filter((entry) => entry.status === "pending" || entry.status === "dropped");
  if (unsettled.length === 0) return records;

  const settled = await Promise.all(
    unsettled.map(async (entry) => {
      const receipt = await client
        .getTransactionReceipt({ hash: entry.hash })
        .catch(() => null);
      if (!receipt) {
        // Only a receipt moves a dropped row; it is never judged dropped twice.
        if (entry.status === "dropped") return null;
        return await wasDropped(client, entry) ? { hash: entry.hash, status: "dropped" as const } : null;
      }
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
            || !onNetworkChain(entry.networkId, network.id)
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

/**
 * What Home's pending rows read on every block. Storage only while nothing is
 * pending; only a pending row turns it into listSettled, so a wallet with an
 * old dropped row does not ask the node every three seconds from Home.
 */
export async function listWatched(
  account: Address,
  network: WalletNetwork = activeNetwork,
): Promise<TxRecord[]> {
  const records = await listRecords(account, network);
  if (!records.some((entry) => entry.status === "pending")) return records;
  return listSettled(account, network);
}
