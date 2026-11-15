import { isAddress, type Address, type Hex } from "viem";
import { chromeGet, chromeSet, onChromeChange } from "../platform/chromeStore.ts";
import { withNamedLock } from "../platform/locks.ts";
import { STORAGE_KEYS } from "../platform/storageKeys.ts";
import { type ProposedChain, safeProposedChain, safeWatchAsset, type WatchAsset } from "../lib/dappProposals.ts";

/**
 * State shared by the two halves of the dapp bridge.
 *
 * The service worker never holds key material, so it cannot answer a signing
 * request by itself: it parks the request in `chrome.storage.local` and the
 * approval window — which has the unlocked session key — signs and writes the
 * result back. Storage is the channel because either side may be dead when the
 * other writes, and a killed worker must be able to pick the queue up again.
 *
 * Everything here is JSON, so amounts travel as the strings the dapp sent them
 * as — hex quantities — and are parsed once, in the approval window.
 */
export type DappRequestKind =
  | "connect"
  | "transaction"
  | "sign"
  | "sign-typed"
  | "switch-network"
  | "watch-asset"
  | "add-network";

export interface DappTxRequest {
  to?: Address;
  /** Hex quantity, exactly as the page provided it. */
  value?: string;
  data?: Hex;
  /** Hex quantity; absent means the wallet estimates. */
  gas?: string;
}

export interface DappRequest {
  id: string;
  origin: string;
  /** The page title, shown so the user recognises the site. */
  title?: string;
  kind: DappRequestKind;
  at: number;
  /** Profile selected when the page made the request; old rows omit it. */
  networkId?: string;
  /** Full reviewed RPC/profile identity; prevents edits reusing a profile id. */
  networkIdentity?: string;
  /** Saved profile requested by wallet_switchEthereumChain. */
  targetNetworkId?: string;
  account?: Address;
  tx?: DappTxRequest;
  /** personal_sign payload, or the typed-data JSON string. */
  message?: string;
  /** wallet_watchAsset: the token the page offered, checked by dappProposals. */
  asset?: WatchAsset;
  /** wallet_addEthereumChain: the network exactly as it would be saved. */
  chain?: ProposedChain;
  /**
   * Persistent single-owner token for the approval action. A claimed request
   * stays claimed until its original timeout if the owning window disappears,
   * so another window can never replay a transaction or signature.
   */
  approvalClaim?: string;
  /**
   * The browser tab the asking page lives in, as the browser reported it
   * (sender.tab.id), so a page cannot pick it. Rows from 1.0.9 omit it and are
   * then counted by origin only.
   */
  tabId?: number;
  /**
   * The document that asked (sender.documentId), so a tab that only changed its
   * URL in place keeps its requests. Rows from 1.0.9 omit it.
   */
  documentId?: string;
}

export interface DappResolution {
  id: string;
  /** Transaction hash or signature. */
  result?: string;
  /** EIP-1193 code; 4001 is the user rejecting. */
  code?: number;
  error?: string;
  /** When it was stored; an answer no worker collected is dropped once this is old. */
  at?: number;
}

export interface DappConnection {
  origin: string;
  accounts: Address[];
  at: number;
}

/** Checked without importing env.ts: that module is not service-worker safe. */
const hasChrome = typeof chrome !== "undefined" && !!chrome?.storage?.local;

/** Resolutions are read once and then only kept as a short audit tail. */
const RESOLVED_KEEP = 20;
export const DAPP_REQUEST_TIMEOUT_MS = 240_000;
/** Leaves enough time for the 15s transport and its configured retries. */
export const DAPP_APPROVAL_EXECUTION_BUDGET_MS = 60_000;
/**
 * No signature starts with less than this left before the worker gives up. The
 * broadcast after it (15 s per RPC try, retries, two rechecks) must land while
 * the worker still waits, or the dapp never gets its hash. Below the execution
 * budget, so a fresh claim keeps about 20 s to prepare the transaction.
 */
export const DAPP_SIGN_RESERVE_MS = 40_000;
/**
 * How long the worker still waits after its timeout for a row a window claimed:
 * that window may be broadcasting. The worker timer runs from the row's `at`, and
 * the page gives up at 250 s (inpage.ts), so 240 + 5 s answers it first.
 */
export const DAPP_CLAIM_GRACE_MS = 5_000;
export const MAX_PENDING_REQUESTS = 24;
export const MAX_PENDING_PER_ORIGIN = 4;
/** Every frame is its own origin, so one tab framing many subdomains is capped too. */
export const MAX_PENDING_PER_TAB = 4;
/** Connects from sites not yet trusted; leaves 18 rows for connected sites. */
export const MAX_PENDING_CONNECTS = 6;
const MAX_PENDING_BYTES = 4 * 1024 * 1024;
const MAX_CONNECTIONS = 128;
/**
 * The accounts the user connected to one site, newest first. A 1.0.9 book holds one
 * per site and reads as a one-element list.
 */
export const MAX_ACCOUNTS_PER_ORIGIN = 8;
const MAX_ORIGIN_LENGTH = 2_048;
const MAX_TITLE_LENGTH = 256;
const MAX_MESSAGE_LENGTH = 1_048_576;
const MAX_DATA_LENGTH = 2_000_002;
const CONNECTIONS_LOCK = `dapp:${STORAGE_KEYS.connections}`;
const PENDING_LOCK = `dapp:${STORAGE_KEYS.pending}`;
const RESOLVED_LOCK = `dapp:${STORAGE_KEYS.resolved}`;

type ConnectionBook = Record<string, DappConnection>;
const REQUEST_KINDS = new Set<DappRequestKind>([
  "connect",
  "transaction",
  "sign",
  "sign-typed",
  "switch-network",
  "watch-asset",
  "add-network",
]);
const QUANTITY = /^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/u;
const DATA = /^0x(?:[0-9a-fA-F]{2})*$/u;
const APPROVAL_CLAIM = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
/** Chromium's document id: 32 hex digits. */
export const DOCUMENT_ID = /^[0-9A-F]{32}$/iu;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function safeText(value: unknown, max: number): string | undefined {
  return typeof value === "string"
    && value.length > 0
    && value.length <= max
    && !/[\u0000-\u001f\u007f]/u.test(value)
    ? value
    : undefined;
}

function safeOrigin(value: unknown): string | null {
  if (typeof value !== "string" || value.length > MAX_ORIGIN_LENGTH) return null;
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") && url.origin === value
      ? url.origin
      : null;
  } catch {
    return null;
  }
}

function safeTx(value: unknown): DappTxRequest | undefined {
  const tx = record(value);
  if (!tx) return undefined;
  const to = tx.to === undefined
    ? undefined
    : typeof tx.to === "string" && isAddress(tx.to) ? tx.to : null;
  const valueHex = tx.value === undefined
    ? undefined
    : typeof tx.value === "string" && tx.value.length <= 66 && QUANTITY.test(tx.value)
      ? tx.value
      : null;
  const gas = tx.gas === undefined
    ? undefined
    : typeof tx.gas === "string" && tx.gas.length <= 66 && QUANTITY.test(tx.gas)
      ? tx.gas
      : null;
  const data = tx.data === undefined
    ? undefined
    : typeof tx.data === "string" && tx.data.length <= MAX_DATA_LENGTH && DATA.test(tx.data)
      ? tx.data
      : null;
  if (to === null || valueHex === null || gas === null || data === null) return undefined;
  return {
    to: to as Address | undefined,
    value: valueHex,
    gas,
    data: data as Hex | undefined,
  };
}

function safeRequest(value: unknown): DappRequest | null {
  const entry = record(value);
  if (!entry) return null;
  const id = safeText(entry.id, 128);
  const origin = safeOrigin(entry.origin);
  const kind = typeof entry.kind === "string" && REQUEST_KINDS.has(entry.kind as DappRequestKind)
    ? entry.kind as DappRequestKind
    : null;
  const at = Number(entry.at);
  const account = typeof entry.account === "string" && isAddress(entry.account)
    ? entry.account
    : null;
  const title = entry.title === undefined || entry.title === ""
    ? undefined
    : safeText(entry.title, MAX_TITLE_LENGTH);
  const networkId = entry.networkId === undefined ? undefined : safeText(entry.networkId, 96);
  const networkIdentity = entry.networkIdentity === undefined
    ? undefined
    : safeText(entry.networkIdentity, 8_192);
  const targetNetworkId = entry.targetNetworkId === undefined
    ? undefined
    : safeText(entry.targetNetworkId, 96);
  const message = entry.message === undefined
    ? undefined
    : typeof entry.message === "string" && entry.message.length <= MAX_MESSAGE_LENGTH
      ? entry.message
      : undefined;
  const approvalClaim = entry.approvalClaim === undefined
    ? undefined
    : typeof entry.approvalClaim === "string" && APPROVAL_CLAIM.test(entry.approvalClaim)
      ? entry.approvalClaim
      : null;
  const tx = kind === "transaction" ? safeTx(entry.tx) : undefined;
  // Read only for their own kind: on any other row they are ignored.
  const asset = kind === "watch-asset" ? safeWatchAsset(entry.asset) : undefined;
  const chain = kind === "add-network" ? safeProposedChain(entry.chain) : undefined;
  // A bad tab id only loses the per-tab count; it never makes the row unreadable.
  const tabId = typeof entry.tabId === "number" && Number.isSafeInteger(entry.tabId) && entry.tabId >= 0
    ? entry.tabId
    : undefined;
  // Likewise a bad document id only loses the in-place navigation check.
  const documentId = typeof entry.documentId === "string" && DOCUMENT_ID.test(entry.documentId)
    ? entry.documentId
    : undefined;
  if (
    !id
    || !origin
    || kind === null
    || !Number.isFinite(at)
    || at <= 0
    || account === null
    || (entry.title !== undefined && entry.title !== "" && title === undefined)
    || (entry.networkId !== undefined && networkId === undefined)
    || (entry.networkIdentity !== undefined && networkIdentity === undefined)
    || (kind === "transaction" && tx === undefined)
    || ((kind === "sign" || kind === "sign-typed") && message === undefined)
    || (kind === "switch-network" && targetNetworkId === undefined)
    || asset === null
    || chain === null
    || approvalClaim === null
  ) return null;
  return {
    id,
    origin,
    title,
    kind,
    at,
    networkId,
    networkIdentity,
    targetNetworkId,
    account,
    tx,
    message,
    approvalClaim,
    ...(asset === undefined ? {} : { asset }),
    ...(chain === undefined ? {} : { chain }),
    ...(tabId === undefined ? {} : { tabId }),
    ...(documentId === undefined ? {} : { documentId }),
  };
}

export function sanitizePendingRequests(value: unknown): DappRequest[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, MAX_PENDING_REQUESTS).map(safeRequest).filter(
    (entry): entry is DappRequest => entry !== null,
  );
}

export type PendingAdmission =
  | {
      accepted: true;
      queue: DappRequest[];
      expiredIds: string[];
      /** The expired rows a window had claimed: answered "may have been sent", never 4001. */
      maybeSentIds: string[];
    }
  | {
      accepted: false;
      reason:
        | "duplicate-connect"
        | "duplicate-asset"
        | "duplicate-network"
        | "origin-limit"
        | "tab-limit"
        | "connect-limit"
        | "queue-limit"
        | "storage-limit";
    };

/**
 * How long a row stays in the queue. A claimed row outlives the worker timeout by
 * the execution budget: its window may still be broadcasting, and dropping it
 * would turn the hash it is about to write into an answer nobody can take.
 */
function pendingLifetime(entry: DappRequest): number {
  return DAPP_REQUEST_TIMEOUT_MS + (entry.approvalClaim === undefined ? 0 : DAPP_APPROVAL_EXECUTION_BUDGET_MS);
}

function pendingLive(entry: DappRequest, now: number): boolean {
  const age = now - entry.at;
  return Number.isFinite(age) && age < pendingLifetime(entry);
}

export type PendingClaimPlan =
  | { accepted: true; queue: DappRequest[] }
  | { accepted: false; reason: "missing" | "claimed" | "expired" | "invalid-claim" };

export interface PendingClaimReleasePlan {
  released: boolean;
  queue: DappRequest[];
}

function pendingBytes(queue: DappRequest[]): number {
  try {
    return new TextEncoder().encode(JSON.stringify(queue)).byteLength;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/** Pure admission plan, exported so queue limits stay pinned by unit tests. */
export function planPendingAdmission(
  queue: DappRequest[],
  request: DappRequest,
  now = Date.now(),
): PendingAdmission {
  const fresh: DappRequest[] = [];
  const expiredIds: string[] = [];
  const maybeSentIds: string[] = [];
  for (const entry of queue) {
    if (pendingLive(entry, now)) fresh.push(entry);
    else {
      expiredIds.push(entry.id);
      if (entry.approvalClaim !== undefined) maybeSentIds.push(entry.id);
    }
  }

  if (
    request.kind === "connect"
    && fresh.some((entry) => entry.kind === "connect" && entry.origin === request.origin)
  ) {
    return { accepted: false, reason: "duplicate-connect" };
  }
  // One prompt per token and one network proposal per site at a time: a page
  // repeating its button press must not stack windows the user has to clear.
  if (
    request.kind === "watch-asset"
    && fresh.some((entry) => entry.kind === "watch-asset" && entry.origin === request.origin
      && entry.asset?.address === request.asset?.address)
  ) {
    return { accepted: false, reason: "duplicate-asset" };
  }
  if (
    request.kind === "add-network"
    && fresh.some((entry) => entry.kind === "add-network" && entry.origin === request.origin)
  ) {
    return { accepted: false, reason: "duplicate-network" };
  }
  if (fresh.filter((entry) => entry.origin === request.origin).length >= MAX_PENDING_PER_ORIGIN) {
    return { accepted: false, reason: "origin-limit" };
  }
  if (
    request.tabId !== undefined
    && fresh.filter((entry) => entry.tabId === request.tabId).length >= MAX_PENDING_PER_TAB
  ) {
    return { accepted: false, reason: "tab-limit" };
  }
  if (
    request.kind === "connect"
    && fresh.filter((entry) => entry.kind === "connect").length >= MAX_PENDING_CONNECTS
  ) {
    return { accepted: false, reason: "connect-limit" };
  }
  if (fresh.length >= MAX_PENDING_REQUESTS) {
    return { accepted: false, reason: "queue-limit" };
  }

  const next = [...fresh, request];
  if (pendingBytes(next) > MAX_PENDING_BYTES) {
    return { accepted: false, reason: "storage-limit" };
  }
  return { accepted: true, queue: next, expiredIds, maybeSentIds };
}

/** Pure claim planner: only one approval document can own a persisted request. */
export function planPendingClaim(
  queue: DappRequest[],
  id: string,
  approvalClaim: string,
  now = Date.now(),
): PendingClaimPlan {
  if (!APPROVAL_CLAIM.test(approvalClaim)) {
    return { accepted: false, reason: "invalid-claim" };
  }
  const index = queue.findIndex((entry) => entry.id === id);
  if (index < 0) return { accepted: false, reason: "missing" };
  const request = queue[index];
  if (!request) return { accepted: false, reason: "missing" };
  if (request.approvalClaim !== undefined) {
    return { accepted: false, reason: "claimed" };
  }
  if (request.at + DAPP_REQUEST_TIMEOUT_MS - now < DAPP_APPROVAL_EXECUTION_BUDGET_MS) {
    return { accepted: false, reason: "expired" };
  }
  const next = [...queue];
  next[index] = { ...request, approvalClaim };
  return { accepted: true, queue: next };
}

/** A failed pre-submit attempt may release only the exact claim it acquired. */
export function planPendingClaimRelease(
  queue: DappRequest[],
  id: string,
  approvalClaim: string,
): PendingClaimReleasePlan {
  const index = queue.findIndex((entry) => entry.id === id);
  const request = index < 0 ? undefined : queue[index];
  if (!request || request.approvalClaim !== approvalClaim) {
    return { released: false, queue };
  }
  const next = [...queue];
  const released = { ...request };
  delete released.approvalClaim;
  next[index] = released;
  return { released: true, queue: next };
}

export function newRequestId(): string {
  return crypto.randomUUID();
}

async function readConnections(): Promise<ConnectionBook> {
  if (!hasChrome) return {};
  const raw = record(await chromeGet<unknown>("local", STORAGE_KEYS.connections));
  if (!raw) return {};
  const book: ConnectionBook = {};
  for (const value of Object.values(raw).slice(0, MAX_CONNECTIONS)) {
    const entry = record(value);
    const origin = safeOrigin(entry?.origin);
    const accounts = Array.isArray(entry?.accounts)
      ? distinctAccounts(entry.accounts.filter((account): account is Address =>
          typeof account === "string" && isAddress(account)
        ))
      : [];
    const at = Number(entry?.at);
    if (!origin || accounts.length === 0 || !Number.isFinite(at) || at <= 0) continue;
    book[origin] = { origin, accounts, at };
  }
  return book;
}

export async function listConnections(): Promise<DappConnection[]> {
  const book = await readConnections();
  return Object.values(book).sort((a, b) => b.at - a.at);
}

/** First spelling of each address wins, so a list never holds one account twice. */
function distinctAccounts(accounts: readonly Address[]): Address[] {
  const seen = new Set<string>();
  return accounts.filter((account) => {
    const key = account.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, MAX_ACCOUNTS_PER_ORIGIN);
}

/**
 * The account the wallet signs with. The worker and the approval window resolve
 * it the same way, so a site is never shown one account and asked for another.
 */
export function resolveActiveAccount(
  state: { active?: string | null; accounts?: readonly { address?: string }[] } | null | undefined,
): string | null {
  return state?.active ?? state?.accounts?.[0]?.address ?? null;
}

/**
 * What a site may see: the active account, and only if the user connected that
 * account to it. A site granted other accounts sees none until the user connects
 * this one too, so switching account never links two addresses for a site.
 */
export function visibleAccounts(granted: readonly Address[], active: string | null | undefined): Address[] {
  if (!active) return [];
  const hit = granted.find((account) => account.toLowerCase() === active.toLowerCase());
  return hit ? [hit] : [];
}

export async function connectedAccounts(origin: string, active: string | null | undefined): Promise<Address[]> {
  const book = await readConnections();
  return visibleAccounts(book[origin]?.accounts ?? [], active);
}

/** Adds the accounts to the site's list (newest first, capped); others it had stay. */
export async function grantConnection(origin: string, accounts: Address[]): Promise<void> {
  if (!hasChrome) return;
  await withNamedLock(CONNECTIONS_LOCK, async () => {
    const book = await readConnections();
    const next = [...Object.values(book).filter((entry) => entry.origin !== origin), {
      origin,
      accounts: distinctAccounts([...accounts, ...(book[origin]?.accounts ?? [])]),
      at: Date.now(),
    }]
      .sort((left, right) => right.at - left.at)
      .slice(0, MAX_CONNECTIONS);
    await chromeSet(
      "local",
      STORAGE_KEYS.connections,
      Object.fromEntries(next.map((entry) => [entry.origin, entry])),
    );
  });
}

export async function revokeConnection(origin: string): Promise<void> {
  if (!hasChrome) return;
  await withNamedLock(CONNECTIONS_LOCK, async () => {
    const book = await readConnections();
    delete book[origin];
    await chromeSet("local", STORAGE_KEYS.connections, book);
  });
}
export async function listPending(): Promise<DappRequest[]> {
  if (!hasChrome) return [];
  return sanitizePendingRequests(await chromeGet<unknown>("local", STORAGE_KEYS.pending));
}

export async function pushPending(request: DappRequest): Promise<PendingAdmission> {
  if (!hasChrome) return { accepted: false, reason: "storage-limit" };
  return withNamedLock(PENDING_LOCK, async () => {
    const queue = await listPending();
    const admission = planPendingAdmission(queue, request);
    if (!admission.accepted) return admission;
    await chromeSet("local", STORAGE_KEYS.pending, admission.queue);
    return admission;
  });
}

export type PendingClaimOutcome =
  | { claim: string }
  | { reason: Extract<PendingClaimPlan, { accepted: false }>["reason"] };

/** Atomically assigns a pending request to one approval window. */
export async function claimPendingRequest(id: string): Promise<PendingClaimOutcome> {
  if (!hasChrome) return { reason: "missing" };
  const approvalClaim = crypto.randomUUID();
  return withNamedLock(PENDING_LOCK, async () => {
    const plan = planPendingClaim(await listPending(), id, approvalClaim);
    if (!plan.accepted) return { reason: plan.reason };
    await chromeSet("local", STORAGE_KEYS.pending, plan.queue);
    return { claim: approvalClaim };
  });
}

/**
 * What the approval window says when it could not claim a request. It never
 * closes itself for this: closing rejects every other queued request. An expired
 * row can no longer be claimed by anyone, so the window answers it for the
 * worker; `heldHere` is a transaction this window signed and still holds. A
 * missing row is mostly one the worker answered (its page closed or reloaded, or
 * it timed out), so that notice names no cause.
 */
export function unclaimedNotice(
  reason: Extract<PendingClaimOutcome, { reason: unknown }>["reason"],
  heldHere: boolean,
): { notice: "apr.expired" | "apr.alreadyHandled" | "apr.maybeSent" | "apr.gone"; rejectExpired: boolean } {
  if (reason === "claimed" && heldHere) return { notice: "apr.maybeSent", rejectExpired: false };
  if (reason === "expired") return { notice: "apr.expired", rejectExpired: true };
  if (reason === "missing") return { notice: "apr.gone", rejectExpired: false };
  return { notice: "apr.alreadyHandled", rejectExpired: false };
}

/**
 * What an approval window shows: only rows it can act on, the unclaimed ones and
 * those it holds itself. A row another window claimed is answered by the worker's
 * grace or expiry path; showing it would leave Approve and Reject saying "already
 * answered" with the newer requests behind it out of reach.
 */
export function approvalView(
  queue: DappRequest[],
  wanted: string | null,
  ownsClaim: (id: string) => boolean,
): { request: DappRequest | null; actionable: DappRequest[] } {
  const actionable = queue.filter((entry) => entry.approvalClaim === undefined || ownsClaim(entry.id));
  return {
    request: actionable.find((entry) => entry.id === wanted) ?? actionable[0] ?? null,
    actionable,
  };
}

/**
 * The answer for a transaction that was signed but whose fate is unknown. It is
 * never 4001: a dapp told "rejected" offers a retry, and that sends it twice.
 */
export const DAPP_MAYBE_SENT_ERROR =
  "The wallet did not confirm in time. The transaction may have been sent; check the wallet activity before retrying.";

/** Releases a claim only when execution failed before producing a result. */
export async function releasePendingRequestClaim(
  id: string,
  approvalClaim: string,
): Promise<boolean> {
  if (!hasChrome) return false;
  return withNamedLock(PENDING_LOCK, async () => {
    const plan = planPendingClaimRelease(await listPending(), id, approvalClaim);
    if (!plan.released) return false;
    await chromeSet("local", STORAGE_KEYS.pending, plan.queue);
    return true;
  });
}

/**
 * Pure startup planner. Besides expired rows, a row queued before `orphanedBefore`
 * (this worker's start) that no approval window has claimed is stale too: the restart
 * closed the page's message channel, so its dapp already saw 4900 and nobody would
 * receive the result. Re-presenting it would sign or send for no one, and a retry by
 * the dapp would then do it twice.
 */
export function planStalePending(
  queue: DappRequest[],
  now: number,
  orphanedBefore = Number.NEGATIVE_INFINITY,
): { fresh: DappRequest[]; stale: DappRequest[] } {
  const fresh: DappRequest[] = [];
  const stale: DappRequest[] = [];
  for (const entry of queue) {
    const orphaned = entry.approvalClaim === undefined && entry.at < orphanedBefore;
    if (pendingLive(entry, now) && !orphaned) fresh.push(entry);
    else stale.push(entry);
  }
  return { fresh, stale };
}

/**
 * The answer for a row the worker drops unanswered. A claimed row may have been
 * signed and broadcast by its window, so it is never called a rejection.
 */
export function expiryAnswer(entry: Pick<DappRequest, "approvalClaim">): { error: string; code: number } {
  return entry.approvalClaim === undefined
    ? { error: "Request expired", code: 4001 }
    : { error: DAPP_MAYBE_SENT_ERROR, code: -32603 };
}

/**
 * Pure planner for a tab that closed or started loading another page. Its
 * unclaimed rows have no page left to answer and would block that page's next
 * connect with -32002; a claimed row is executing and keeps its window. Rows of
 * other tabs, and 1.0.9 rows without a tab, stay.
 *
 * `deadDocuments` is given when the tab still exists: a row that names its
 * document then goes only if that document was asked and did not answer, so a
 * pushState or a hash change keeps it, and so does a row queued after the asking
 * (its document is the new, live one). A row without a document goes, as before.
 */
export function planTabGone(
  queue: DappRequest[],
  tabId: number,
  deadDocuments?: ReadonlySet<string>,
): { fresh: DappRequest[]; gone: DappRequest[] } {
  const fresh: DappRequest[] = [];
  const gone: DappRequest[] = [];
  for (const entry of queue) {
    const documentGone = deadDocuments === undefined
      || entry.documentId === undefined
      || deadDocuments.has(entry.documentId);
    if (entry.tabId === tabId && entry.approvalClaim === undefined && documentGone) gone.push(entry);
    else fresh.push(entry);
  }
  return { fresh, gone };
}

/**
 * The documents a tab's unclaimed rows name, which the worker asks are still
 * there before it answers their rows as gone.
 */
export function tabDocuments(queue: DappRequest[], tabId: number): string[] {
  const documents = new Set<string>();
  for (const entry of queue) {
    if (entry.tabId === tabId && entry.approvalClaim === undefined && entry.documentId !== undefined) {
      documents.add(entry.documentId);
    }
  }
  return [...documents];
}

/** Takes a gone tab's unclaimed rows under the queue lock, so no window can claim one meanwhile. */
export async function takeTabRequests(tabId: number, deadDocuments?: ReadonlySet<string>): Promise<DappRequest[]> {
  if (!hasChrome) return [];
  return withNamedLock(PENDING_LOCK, async () => {
    const { fresh, gone } = planTabGone(await listPending(), tabId, deadDocuments);
    if (gone.length > 0) await chromeSet("local", STORAGE_KEYS.pending, fresh);
    return gone;
  });
}

/** Claims stale rows under the same lock as push/drop so startup cannot race a new request. */
export async function takeExpiredPending(now = Date.now(), orphanedBefore?: number): Promise<DappRequest[]> {
  if (!hasChrome) return [];
  return withNamedLock(PENDING_LOCK, async () => {
    const { fresh, stale } = planStalePending(await listPending(), now, orphanedBefore);
    if (stale.length > 0) await chromeSet("local", STORAGE_KEYS.pending, fresh);
    return stale;
  });
}

export function watchPending(handler: (queue: DappRequest[]) => void): () => void {
  if (!hasChrome) return () => {};
  return onChromeChange("local", STORAGE_KEYS.pending, (value) => {
    handler(sanitizePendingRequests(value));
  });
}

async function readResolutions(): Promise<DappResolution[]> {
  if (!hasChrome) return [];
  const raw = await chromeGet<unknown>("local", STORAGE_KEYS.resolved);
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, RESOLVED_KEEP).flatMap((value) => {
    const entry = record(value);
    const id = safeText(entry?.id, 128);
    const result = entry?.result === undefined
      ? undefined
      : safeText(entry.result, MAX_DATA_LENGTH);
    const error = entry?.error === undefined ? undefined : safeText(entry.error, 512);
    const code = entry?.code === undefined ? undefined : Number(entry.code);
    const at = typeof entry?.at === "number" ? entry.at : undefined;
    if (
      !id
      || (entry?.result !== undefined && result === undefined)
      || (entry?.error !== undefined && error === undefined)
      || (code !== undefined && !Number.isSafeInteger(code))
      || (result === undefined && error === undefined)
    ) return [];
    return [{ id, result, error, code, at } satisfies DappResolution];
  });
}

/**
 * Answers still worth keeping. The worker that waits for one stops waiting after
 * DAPP_REQUEST_TIMEOUT_MS, so an older answer (or one with no timestamp) has no
 * reader left: its worker restarted or timed out. It may hold a signature, and
 * must not sit in extension storage until twenty newer answers push it out.
 */
export function liveResolutions(list: DappResolution[], now: number): DappResolution[] {
  // Absolute difference: a clock stepped back a moment must not drop a fresh answer.
  return list.filter((entry) => Math.abs(now - (entry.at ?? Number.NaN)) < DAPP_REQUEST_TIMEOUT_MS);
}

async function writeResolution(
  resolution: DappResolution,
  approvalClaim?: string,
): Promise<boolean> {
  if (!hasChrome) return false;
  return withNamedLock(RESOLVED_LOCK, () => withNamedLock(PENDING_LOCK, async () => {
    const queue = await listPending();
    if (
      approvalClaim !== undefined
      && !queue.some((entry) =>
        entry.id === resolution.id && entry.approvalClaim === approvalClaim
      )
    ) return false;

    const now = Date.now();
    const list = liveResolutions(await readResolutions(), now);
    const next = [{ ...resolution, at: now }, ...list.filter((entry) => entry.id !== resolution.id)];
    // Remove the executable request first. If the following resolution write
    // fails, the page may time out, but no second window can replay the action.
    await chromeSet(
      "local",
      STORAGE_KEYS.pending,
      queue.filter((entry) => entry.id !== resolution.id),
    );
    await chromeSet("local", STORAGE_KEYS.resolved, next.slice(0, RESOLVED_KEEP));
    return true;
  }));
}

export async function resolveRequest(
  id: string,
  result: string,
  approvalClaim: string,
): Promise<boolean> {
  return writeResolution({ id, result }, approvalClaim);
}

export async function rejectClaimedRequest(
  id: string,
  approvalClaim: string,
  error = "User rejected the request",
  code = 4001,
): Promise<boolean> {
  return writeResolution({ id, code, error }, approvalClaim);
}

/**
 * System-owned rejection for expiry/window-open failures. User actions use the
 * claim-checked variant above so two approval documents cannot race each other.
 */
export async function rejectRequest(
  id: string,
  error = "User rejected the request",
  code = 4001,
): Promise<void> {
  await writeResolution({ id, code, error });
}

async function consumeResolution(id: string): Promise<void> {
  if (!hasChrome) return;
  await withNamedLock(RESOLVED_LOCK, async () => {
    const list = await readResolutions();
    const next = liveResolutions(list, Date.now()).filter((entry) => entry.id !== id);
    if (next.length !== list.length) {
      await chromeSet("local", STORAGE_KEYS.resolved, next);
    }
  });
}

/** Drops answers no worker can still be waiting for. Run when a worker starts. */
export async function pruneResolutions(): Promise<void> {
  // No request has an empty id, so this removes only what has aged out.
  await consumeResolution("");
}


/**
 * The worker's timeout for one row, under the queue lock. An unclaimed row is
 * dropped. A claimed row is kept: its window may be broadcasting, and the hash it
 * writes must still find the row. "missing" means the row was answered or taken
 * meanwhile; any answer was written under this same lock, so it is readable now.
 */
export async function expirePending(id: string): Promise<"dropped" | "claimed" | "missing"> {
  if (!hasChrome) return "missing";
  return withNamedLock(PENDING_LOCK, async () => {
    const queue = await listPending();
    const row = queue.find((entry) => entry.id === id);
    if (!row) return "missing";
    if (row.approvalClaim !== undefined) return "claimed";
    await chromeSet("local", STORAGE_KEYS.pending, queue.filter((entry) => entry.id !== id));
    return "dropped";
  });
}

/**
 * Waits for the approval window to answer. An unclaimed entry is dropped at the
 * timeout, so an abandoned window cannot leave a request pending forever, and the
 * dapp sees that as a rejection. A claimed entry gets DAPP_CLAIM_GRACE_MS more;
 * if its window still has not answered, the dapp is told the transaction may
 * have been sent (-32603), never 4001, which would invite a second send.
 */
export function awaitResolution(id: string, timeoutMs = DAPP_REQUEST_TIMEOUT_MS): Promise<DappResolution> {
  return new Promise<DappResolution>((resolve) => {
    let settled = false;
    let grace: ReturnType<typeof setTimeout> | undefined;
    const finish = (resolution: DappResolution): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(grace);
      stop();
      // The result may contain a transaction hash or signature. It only needs
      // to survive long enough for this worker to consume it, not indefinitely
      // in persistent extension storage.
      void consumeResolution(id).catch(() => undefined).finally(() => resolve(resolution));
    };
    const stop = onChromeChange("local", STORAGE_KEYS.resolved, (value) => {
      if (!Array.isArray(value)) return;
      const hit = value.map((entry) => {
        const item = record(entry);
        return item?.id === id ? item : null;
      }).find((entry) => entry !== null);
      if (!hit) return;
      void readResolutions().then((list) => {
        const resolution = list.find((entry) => entry.id === id);
        if (resolution) finish(resolution);
      });
    });
    const timer = setTimeout(() => {
      void expirePending(id).then(async (state) => {
        if (state === "claimed") {
          grace = setTimeout(() => {
            finish({ id, code: -32603, error: DAPP_MAYBE_SENT_ERROR });
          }, DAPP_CLAIM_GRACE_MS);
          return;
        }
        const answered = state === "missing"
          ? (await readResolutions().catch(() => [])).find((entry) => entry.id === id)
          : undefined;
        finish(answered ?? { id, code: 4001, error: "Request timed out" });
      }, () => {
        // The queue could not be read, so whether a window holds the row is unknown.
        finish({ id, code: -32603, error: DAPP_MAYBE_SENT_ERROR });
      });
    }, timeoutMs);
    // The window may have answered before this listener was attached.
    void readResolutions().then((list) => {
      const hit = list.find((entry) => entry.id === id);
      if (hit) finish(hit);
    });
  });
}
