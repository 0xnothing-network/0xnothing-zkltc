/**
 * Pure rules of the service worker, kept out of background.ts because that file
 * touches chrome.* the moment it loads and so cannot be imported by a test.
 * Nothing here may import anything: the worker bundle stays small and MV3 forbids
 * dynamic import() in a worker.
 */

/** The fields of chrome.runtime.MessageSender these rules read. */
export interface SenderLike {
  id?: string;
  url?: string;
  tab?: unknown;
}

/**
 * A wallet page of this extension: the toolbar popup, the wallet opened in a tab,
 * or the approval window (a popup window, which has a tab). The URL is what the
 * browser loaded, so a content script reports its web page's address here, and
 * the manifest declares no web_accessible_resources a page could frame.
 */
export function isWalletUiSender(sender: SenderLike, extensionId: string): boolean {
  if (sender.id !== extensionId || !sender.url) return false;
  try {
    const url = new URL(sender.url);
    return url.protocol === "chrome-extension:" && url.hostname === extensionId;
  } catch {
    return false;
  }
}

const REQUESTED_CHAIN_ID = /^0x[0-9a-f]{1,16}$/iu;

/**
 * The chainId of wallet_switchEthereumChain / wallet_addEthereumChain. EIP-3326
 * asks for a canonical hex string, but libraries also send "0x01159" or a plain
 * number; both name the same chain. Anything else is invalid params, not an
 * internal error with a JavaScript message in it.
 */
export function parseRequestedChainId(raw: unknown): bigint | null {
  if (typeof raw === "string" && REQUESTED_CHAIN_ID.test(raw)) {
    const id = BigInt(raw);
    return id > 0n ? id : null;
  }
  if (typeof raw === "number" && Number.isSafeInteger(raw) && raw > 0) return BigInt(raw);
  return null;
}

const LOOSE_QUANTITY = /^0x[0-9a-fA-F]{1,64}$/u;

/**
 * A hex quantity as pages send it. ethers v5's toHexString pads to an even length
 * ("0x0de0b6b3a7640000"), which the strict JSON-RPC form refuses although every
 * node and MetaMask accept it. At most 64 digits, the width of a uint256.
 */
export function isLooseQuantity(value: unknown): value is string {
  return typeof value === "string" && LOOSE_QUANTITY.test(value);
}

/** The strict form stored in the queue, so the queue's own check still holds. */
export function canonicalQuantity(value: string): string {
  return `0x${BigInt(value).toString(16)}`;
}

/** How long connect stays refused for a site and its tab after a refused connect. */
export const CONNECT_COOLDOWN_MS = 30_000;
/** Bounds the cooldown book: a page cycling random subdomains cannot grow it. */
export const CONNECT_COOLDOWN_CAP = 256;

/**
 * Records a cooldown until `until`. The oldest entries go first once the book is
 * full; a key set again moves to the end, so a page that keeps asking stays in.
 */
export function noteCooldown(
  book: Map<string, number>,
  key: string,
  until: number,
  cap = CONNECT_COOLDOWN_CAP,
): void {
  book.delete(key);
  book.set(key, until);
  while (book.size > cap) {
    const oldest = book.keys().next().value;
    if (oldest === undefined) break;
    book.delete(oldest);
  }
}

/**
 * The user's own refusal: Reject in the window, or closing it. Expiry, a timeout
 * and a page that went away share the code 4001 but carry their own message.
 */
export function isUserRejection(error: { code: number; message: string }): boolean {
  return error.code === 4001 && error.message === "User rejected the request";
}

/** True while `key` is cooling down; a passed entry is removed on the way. */
export function coolingDown(book: Map<string, number>, key: string, now: number): boolean {
  const until = book.get(key);
  if (until === undefined) return false;
  if (until > now) return true;
  book.delete(key);
  return false;
}

/**
 * Whether the worker is still waiting for request `id`. A worker that died and
 * started again has an empty set, so a row its predecessor queued reads as dead:
 * that page was already told 4900, and approving the row would sign for no one.
 */
export function isAwaiting(awaiting: ReadonlySet<string>, id: unknown): boolean {
  return typeof id === "string" && awaiting.has(id);
}

/**
 * Whether an OS idle state locks the wallet. Only "locked" does: the screen was
 * locked, so whoever unlocks the account next must find the wallet locked too.
 * Plain "idle" (no input for a while) is left to the user's auto-lock timer.
 */
export function locksWallet(state: unknown): boolean {
  return state === "locked";
}

/** The badge holds about four characters; the queue caps keep it far below 99. */
const BADGE_MAX = 99;

/**
 * The toolbar badge for `count` requests waiting for approval: nothing at zero,
 * so an idle wallet carries no mark at all.
 */
export function badgeText(count: number): string {
  if (!Number.isFinite(count) || count < 1) return "";
  const whole = Math.floor(count);
  return whole > BADGE_MAX ? `${BADGE_MAX}+` : String(whole);
}

/** Why one endpoint failed to give a page's read an answer. */
export type RpcFailure =
  | { kind: "transport" }
  | { kind: "http"; status: number }
  | { kind: "body" }
  | { kind: "rpc"; code?: number; message?: string };

/**
 * Whether a page's read moves on to the next endpoint (the public LiteForge one
 * behind the user's own RPC). The same rule as the wallet's viem fallback: any
 * transport, HTTP or body failure, and any JSON-RPC error except a revert, which
 * is the contract's answer and must reach the page as it is.
 */
export function rpcFailover(failure: RpcFailure): boolean {
  if (failure.kind !== "rpc") return true;
  if (failure.code === 3 || failure.code === -32003) return false;
  return !/revert/iu.test(failure.message ?? "");
}

/** One endpoint's attempt: the answer to give, or a failure with the answer kept for the last one. */
export interface RpcAttempt<T> {
  answer: T;
  failure?: RpcFailure;
}

/**
 * Tries `urls` in order inside the caller's one queue slot. An endpoint with a
 * fallback behind it gets 8 s, the last one 15 s, so a dead user RPC leaves time
 * for the public one. The last endpoint's answer, failure or not, is the answer.
 */
export async function tryEndpoints<T>(
  urls: readonly string[],
  attempt: (url: string, timeoutMs: number) => Promise<RpcAttempt<T>>,
): Promise<T> {
  let answer: T | undefined;
  for (const [index, url] of urls.entries()) {
    const last = index === urls.length - 1;
    const outcome = await attempt(url, last ? 15_000 : 8_000);
    answer = outcome.answer;
    if (last || outcome.failure === undefined || !rpcFailover(outcome.failure)) return answer;
  }
  return answer as T;
}
