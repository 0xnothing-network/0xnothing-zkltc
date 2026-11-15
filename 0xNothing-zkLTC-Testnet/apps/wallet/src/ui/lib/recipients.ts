import { withNamedLock } from "../../core/platform/locks";
import { persistentStore } from "../../core/platform/storage";
import { STORAGE_KEYS } from "../../core/platform/storageKeys";

/**
 * Who this wallet has sent to, per account and per chain, newest first. It
 * feeds the Recent row under the recipient field and the warnings beside it:
 * address poisoning plants a look-alike of a real recipient in the history, so
 * an address the wallet has never paid, or one that shares the head and tail
 * of a known one, is said out loud before the review. Warn, never block.
 *
 * Stored shape (`wallet.recipients.v1`):
 *   { [accountLower]: { [chainScope]: Array<{ address: lowercase, at: ms, name?: string }> } }
 * Public data only. Everything read back is validated; a bad entry is dropped,
 * and a bad name is dropped while its entry stays.
 */
export const MAX_RECENT_RECIPIENTS = 12;
/** Code points, after cleaning. */
export const MAX_RECIPIENT_NAME = 24;

export interface RecentRecipient {
  /** Lowercase 0x + 40 hex. */
  address: string;
  at: number;
  /** The user's own label for the address; plain text, shown beside it, never instead of the checks. */
  name?: string;
}

export type RecipientRisk = "known" | "new" | "lookalike";

type Book = Record<string, Record<string, RecentRecipient[]>>;

const HEX_ADDRESS = /^0x[0-9a-f]{40}$/u;
const SCOPE = /^[\w.:-]{1,120}$/u;
const LOCK = "recipients";

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/**
 * A name as the wallet keeps it, or null for none. Control and format
 * characters go (a bidi override could make a label read backwards next to an
 * address), runs of white space become one space, and a name longer than
 * MAX_RECIPIENT_NAME code points is refused rather than cut.
 */
export function cleanRecipientName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = value.replace(/\p{Cf}/gu, "").replace(/\p{Cc}/gu, " ").replace(/\s+/gu, " ").trim();
  if (name.length === 0 || [...name].length > MAX_RECIPIENT_NAME) return null;
  return name;
}

/** The saved name of `address` in `list`, or null. */
export function recipientName(list: readonly RecentRecipient[] | null, address: string): string | null {
  const lower = address.toLowerCase();
  return list?.find((row) => row.address === lower)?.name ?? null;
}

/**
 * A stored list as the UI may use it: valid rows, newest first, no repeats,
 * capped. When the cap bites, named rows are kept before unnamed ones, so a
 * run of new sends never silently takes a name the user gave.
 */
export function parseRecipientList(value: unknown): RecentRecipient[] {
  if (!Array.isArray(value)) return [];
  const rows: RecentRecipient[] = [];
  for (const item of value) {
    const row = record(item);
    if (row === null || typeof row.address !== "string") continue;
    const address = row.address.toLowerCase();
    const at = row.at;
    if (!HEX_ADDRESS.test(address) || typeof at !== "number" || !Number.isFinite(at) || at <= 0) continue;
    const name = cleanRecipientName(row.name);
    rows.push(name === null ? { address, at } : { address, at, name });
  }
  rows.sort((a, b) => b.at - a.at);
  const seen = new Set<string>();
  const unique = rows.filter((row) => !seen.has(row.address) && seen.add(row.address));
  if (unique.length <= MAX_RECENT_RECIPIENTS) return unique;
  const kept = new Set([
    ...unique.filter((row) => row.name !== undefined),
    ...unique.filter((row) => row.name === undefined),
  ].slice(0, MAX_RECENT_RECIPIENTS));
  return unique.filter((row) => kept.has(row));
}

function parseBook(value: unknown): Book {
  const outer = record(value);
  if (outer === null) return {};
  // fromEntries defines own properties, so a "__proto__" key cannot reach a prototype.
  return Object.fromEntries(
    Object.entries(outer)
      .filter(([account]) => HEX_ADDRESS.test(account))
      .map(([account, scopes]) => [
        account,
        Object.fromEntries(
          Object.entries(record(scopes) ?? {})
            .filter(([scope]) => SCOPE.test(scope))
            .map(([scope, list]) => [scope, parseRecipientList(list)]),
        ),
      ]),
  );
}

/** `list` with `address` moved to the front at `at`, keeping its name. */
export function withRecipient(list: readonly RecentRecipient[], address: string, at: number): RecentRecipient[] {
  const lower = address.toLowerCase();
  const name = recipientName(list, lower);
  return parseRecipientList([
    name === null ? { address: lower, at } : { address: lower, at, name },
    ...list.filter((row) => row.address !== lower),
  ]);
}

function head(address: string): string {
  return address.slice(2, 6);
}

function tail(address: string): string {
  return address.slice(-4);
}

/**
 * `known` holds the recent recipients and the wallet's own accounts. Full
 * lowercase addresses are compared, so a real repeat is never flagged; a
 * different address with the same first four and last four hex characters as
 * a known one is the poisoning pattern.
 */
export function recipientRisk(address: string, known: readonly string[]): RecipientRisk {
  const lower = address.toLowerCase();
  const list = known.map((entry) => entry.toLowerCase());
  if (list.includes(lower)) return "known";
  return list.some((entry) => head(entry) === head(lower) && tail(entry) === tail(lower))
    ? "lookalike"
    : "new";
}

export async function recentRecipients(account: string, scope: string): Promise<RecentRecipient[]> {
  const book = parseBook(await persistentStore.get(STORAGE_KEYS.recipients));
  return book[account.toLowerCase()]?.[scope] ?? [];
}

/** Called after a send succeeded. The caller swallows a failure: the send itself went out. */
export async function rememberRecipient(
  account: string,
  scope: string,
  address: string,
  now = Date.now(),
): Promise<void> {
  const owner = account.toLowerCase();
  if (!HEX_ADDRESS.test(owner) || !HEX_ADDRESS.test(address.toLowerCase()) || !SCOPE.test(scope)) return;
  await withNamedLock(LOCK, async () => {
    const book = parseBook(await persistentStore.get(STORAGE_KEYS.recipients));
    const scopes = book[owner] ?? {};
    const next: Book = {
      ...book,
      [owner]: { ...scopes, [scope]: withRecipient(scopes[scope] ?? [], address, now) },
    };
    await persistentStore.set(STORAGE_KEYS.recipients, next);
  });
}

/** Rewrites one scope of one account under the lock; `edit` gets the parsed list. */
async function editScope(
  account: string,
  scope: string,
  edit: (list: RecentRecipient[]) => RecentRecipient[],
): Promise<void> {
  const owner = account.toLowerCase();
  if (!HEX_ADDRESS.test(owner) || !SCOPE.test(scope)) return;
  await withNamedLock(LOCK, async () => {
    const book = parseBook(await persistentStore.get(STORAGE_KEYS.recipients));
    const scopes = book[owner] ?? {};
    await persistentStore.set(STORAGE_KEYS.recipients, {
      ...book,
      [owner]: { ...scopes, [scope]: parseRecipientList(edit(scopes[scope] ?? [])) },
    });
  });
}

/**
 * Names a saved address; an empty or blank `name` clears it. Only an address
 * already in the list can be named. A name that does not pass
 * cleanRecipientName throws and nothing is written.
 */
export async function renameRecipient(account: string, scope: string, address: string, name: string): Promise<void> {
  const clean = cleanRecipientName(name);
  if (clean === null && name.trim().length > 0) throw new Error("recipient name");
  const lower = address.toLowerCase();
  await editScope(account, scope, (list) => list.map((row) => {
    if (row.address !== lower) return row;
    return clean === null ? { address: row.address, at: row.at } : { ...row, name: clean };
  }));
}

/** Removes a saved address, and its name, from one account's list on one chain. */
export async function forgetRecipient(account: string, scope: string, address: string): Promise<void> {
  const lower = address.toLowerCase();
  await editScope(account, scope, (list) => list.filter((row) => row.address !== lower));
}
