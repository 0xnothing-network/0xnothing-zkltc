/**
 * Rules of the opt-in notifications (Settings > Appearance). Pure and import-free,
 * like workerRules.ts, so the worker and the tests share them.
 *
 * The worker never writes history and holds no catalog: what a notification says
 * comes from the History label templates the wallet page wrote in the language on
 * screen (`wallet.notifyText.v1`), with English titles as the last fallback.
 */

/** Pending rows older than this are left to History's own settling. */
export const WATCH_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Receipt reads per alarm tick. */
export const MAX_WATCHED = 6;
/** A dapp request counts as unseen after this long in the queue. */
export const UNSEEN_AFTER_MS = 60_000;
/** Notification ids remembered so none is shown twice. */
export const MAX_NOTIFIED = 256;
const MAX_TEXT_KEYS = 120;
const MAX_TEMPLATE = 200;
const MAX_MESSAGE = 120;

export const NOTIFY_FALLBACK = {
  "notif.confirmed": "Transaction confirmed",
  "notif.failed": "Transaction failed",
  "notif.waiting": "A site is waiting for your approval",
} as const;

export type NotifyText = Record<string, string>;

export interface WatchedTx {
  hash: string;
  /** Network profile id of the row; old rows without one are on the built-in chain. */
  networkId: string | undefined;
  account: string;
  at: number;
  /** The stored row, for its summary. */
  row: Record<string, unknown>;
}

const HASH = /^0x[0-9a-f]{64}$/u;
const NOTIFIED_ID = /^(?:tx:0x[0-9a-f]{64}|req:[0-9a-f-]{8,64})$/u;
const TEXT_KEY = /^[a-z]+\.[A-Za-z0-9]{1,48}$/u;

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function txNotificationId(hash: string): string {
  return `tx:${hash.toLowerCase()}`;
}

export function requestNotificationId(id: string): string {
  return `req:${id.toLowerCase()}`;
}

/** The stored list of shown notification ids, oldest first. Anything invalid is dropped. */
export function parseNotified(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const ids = value.filter((entry): entry is string => typeof entry === "string" && NOTIFIED_ID.test(entry));
  return [...new Set(ids)].slice(-MAX_NOTIFIED);
}

/** `list` with `id` appended, the oldest dropped past the cap. */
export function withNotified(list: readonly string[], id: string): string[] {
  return parseNotified([...list.filter((entry) => entry !== id), id]);
}

/** The text cache the wallet page wrote. Own properties only; bad entries dropped. */
export function parseNotifyText(value: unknown): NotifyText {
  const outer = record(value);
  if (outer === null) return {};
  return Object.fromEntries(
    Object.entries(outer)
      .filter(([key, text]) => TEXT_KEY.test(key) && typeof text === "string" && text.length <= MAX_TEMPLATE)
      .slice(0, MAX_TEXT_KEYS),
  ) as NotifyText;
}

export function notifyTitle(text: NotifyText, key: keyof typeof NOTIFY_FALLBACK): string {
  return clean(text[key] ?? NOTIFY_FALLBACK[key]) || NOTIFY_FALLBACK[key];
}

/** Plain one-line text: control and format characters out, 120 code points at most. */
function clean(value: string): string {
  const line = value.replace(/\p{Cf}/gu, "").replace(/\p{Cc}/gu, " ").replace(/\s+/gu, " ").trim();
  const points = [...line];
  return points.length > MAX_MESSAGE ? `${points.slice(0, MAX_MESSAGE - 1).join("")}…` : line;
}

/**
 * The History summary of a stored row: its label template with the row's own
 * parameters, else the legacy finished summary, else the short hash.
 */
export function txMessage(row: unknown, text: NotifyText): string {
  const entry = record(row) ?? {};
  const hash = typeof entry.hash === "string" ? entry.hash : "";
  const label = record(entry.label);
  const template = label !== null && typeof label.key === "string" && Object.hasOwn(text, label.key)
    ? text[label.key]
    : undefined;
  if (template !== undefined) {
    const params = record(label?.params) ?? {};
    const filled = template.replace(/\{(\w+)\}/gu, (whole, name: string) => {
      const value = Object.hasOwn(params, name) ? params[name] : undefined;
      return typeof value === "string" || typeof value === "number" ? String(value) : whole;
    });
    const line = clean(filled);
    if (line) return line;
  }
  if (typeof entry.summary === "string" && clean(entry.summary)) return clean(entry.summary);
  return hash.length > 14 ? `${hash.slice(0, 8)}…${hash.slice(-6)}` : hash;
}

function rows(book: unknown): Record<string, unknown>[] {
  const accounts = record(book);
  if (accounts === null) return [];
  return Object.values(accounts).flatMap((list) => (
    Array.isArray(list) ? list.map(record).filter((row): row is Record<string, unknown> => row !== null) : []
  ));
}

function recentPending(row: Record<string, unknown>, now: number): boolean {
  return row.status === "pending"
    && typeof row.hash === "string" && HASH.test(row.hash.toLowerCase())
    && typeof row.at === "number" && row.at > now - WATCH_WINDOW_MS && row.at <= now + 60_000;
}

/**
 * The pending rows the worker reads receipts for: recent, not yet notified, on a
 * network that is still saved; newest first, MAX_WATCHED at most.
 */
export function watchedRows(
  book: unknown,
  now: number,
  notified: readonly string[],
  saved: (networkId: string | undefined) => boolean,
): WatchedTx[] {
  const shown = new Set(notified);
  const seen = new Set<string>();
  return rows(book)
    .filter((row) => recentPending(row, now))
    .map((row) => ({
      hash: (row.hash as string).toLowerCase(),
      networkId: typeof row.networkId === "string" ? row.networkId : undefined,
      account: typeof row.account === "string" ? row.account : "",
      at: row.at as number,
      row,
    }))
    .filter((row) => !shown.has(txNotificationId(row.hash)) && saved(row.networkId)
      && !seen.has(row.hash) && Boolean(seen.add(row.hash)))
    .sort((a, b) => b.at - a.at)
    .slice(0, MAX_WATCHED);
}

/**
 * Rows a wallet page settled in one history write: pending before, success or
 * failed after, recent and not yet notified.
 */
export function settledInWrite(
  before: unknown,
  after: unknown,
  now: number,
  notified: readonly string[],
): { row: Record<string, unknown>; ok: boolean }[] {
  const wasPending = new Set(rows(before)
    .filter((row) => recentPending(row, now))
    .map((row) => (row.hash as string).toLowerCase()));
  const shown = new Set(notified);
  const out: { row: Record<string, unknown>; ok: boolean }[] = [];
  for (const row of rows(after)) {
    if (typeof row.hash !== "string") continue;
    const hash = row.hash.toLowerCase();
    if (!wasPending.has(hash) || shown.has(txNotificationId(hash))) continue;
    if (row.status !== "success" && row.status !== "failed") continue;
    wasPending.delete(hash);
    out.push({ row, ok: row.status === "success" });
  }
  return out;
}

/** The outcome of a raw eth_getTransactionReceipt answer: true mined ok, false reverted, null not yet. */
export function receiptOutcome(answer: unknown): boolean | null {
  const receipt = record(answer);
  if (receipt === null) return null;
  if (receipt.status === "0x1") return true;
  if (receipt.status === "0x0") return false;
  return null;
}

/** Queued requests waiting longer than UNSEEN_AFTER_MS that were not announced yet. */
export function unseenRequests<T extends { id: string; at: number; origin: string }>(
  queue: readonly T[],
  now: number,
  notified: readonly string[],
): T[] {
  const shown = new Set(notified);
  return queue.filter((request) => (
    now - request.at >= UNSEEN_AFTER_MS && !shown.has(requestNotificationId(request.id))
  ));
}
