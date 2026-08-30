import { isAddress, type Address, type Hex } from "viem";
import { chromeGet, chromeSet, onChromeChange } from "../platform/chromeStore.ts";
import { withNamedLock } from "../platform/locks.ts";
import { STORAGE_KEYS } from "../platform/storageKeys.ts";

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
  | "switch-network";

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
  /** Saved profile requested by wallet_switchEthereumChain. */
  targetNetworkId?: string;
  account?: Address;
  tx?: DappTxRequest;
  /** personal_sign payload, or the typed-data JSON string. */
  message?: string;
}

export interface DappResolution {
  id: string;
  /** Transaction hash or signature. */
  result?: string;
  /** EIP-1193 code; 4001 is the user rejecting. */
  code?: number;
  error?: string;
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
export const MAX_PENDING_REQUESTS = 24;
export const MAX_PENDING_PER_ORIGIN = 4;
const MAX_PENDING_BYTES = 4 * 1024 * 1024;
const MAX_CONNECTIONS = 128;
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
]);
const QUANTITY = /^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/u;
const DATA = /^0x(?:[0-9a-fA-F]{2})*$/u;

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
  const targetNetworkId = entry.targetNetworkId === undefined
    ? undefined
    : safeText(entry.targetNetworkId, 96);
  const message = entry.message === undefined
    ? undefined
    : typeof entry.message === "string" && entry.message.length <= MAX_MESSAGE_LENGTH
      ? entry.message
      : undefined;
  const tx = kind === "transaction" ? safeTx(entry.tx) : undefined;
  if (
    !id
    || !origin
    || kind === null
    || !Number.isFinite(at)
    || at <= 0
    || account === null
    || (entry.title !== undefined && entry.title !== "" && title === undefined)
    || (entry.networkId !== undefined && networkId === undefined)
    || (kind === "transaction" && tx === undefined)
    || ((kind === "sign" || kind === "sign-typed") && message === undefined)
    || (kind === "switch-network" && targetNetworkId === undefined)
  ) return null;
  return {
    id,
    origin,
    title,
    kind,
    at,
    networkId,
    targetNetworkId,
    account,
    tx,
    message,
  };
}

export function sanitizePendingRequests(value: unknown): DappRequest[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, MAX_PENDING_REQUESTS).map(safeRequest).filter(
    (entry): entry is DappRequest => entry !== null,
  );
}

export type PendingAdmission =
  | { accepted: true; queue: DappRequest[]; expiredIds: string[] }
  | {
      accepted: false;
      reason: "duplicate-connect" | "origin-limit" | "queue-limit" | "storage-limit";
    };

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
  for (const entry of queue) {
    const age = now - entry.at;
    if (Number.isFinite(age) && age < DAPP_REQUEST_TIMEOUT_MS) fresh.push(entry);
    else expiredIds.push(entry.id);
  }

  if (
    request.kind === "connect"
    && fresh.some((entry) => entry.kind === "connect" && entry.origin === request.origin)
  ) {
    return { accepted: false, reason: "duplicate-connect" };
  }
  if (fresh.filter((entry) => entry.origin === request.origin).length >= MAX_PENDING_PER_ORIGIN) {
    return { accepted: false, reason: "origin-limit" };
  }
  if (fresh.length >= MAX_PENDING_REQUESTS) {
    return { accepted: false, reason: "queue-limit" };
  }

  const next = [...fresh, request];
  if (pendingBytes(next) > MAX_PENDING_BYTES) {
    return { accepted: false, reason: "storage-limit" };
  }
  return { accepted: true, queue: next, expiredIds };
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
      ? entry.accounts.filter((account): account is Address =>
          typeof account === "string" && isAddress(account)
        ).slice(0, 1)
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

export async function connectedAccounts(origin: string): Promise<Address[]> {
  const book = await readConnections();
  return book[origin]?.accounts ?? [];
}

export async function grantConnection(origin: string, accounts: Address[]): Promise<void> {
  if (!hasChrome) return;
  await withNamedLock(CONNECTIONS_LOCK, async () => {
    const book = await readConnections();
    const next = [...Object.values(book).filter((entry) => entry.origin !== origin), {
      origin,
      accounts: accounts.slice(0, 1),
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
/**
 * Switching account re-points every granted origin at the new one. A dapp is
 * only ever told about the active account, so a connection cannot become a way
 * to enumerate the other addresses in the wallet.
 */
export async function setConnectedAccount(account: Address): Promise<void> {
  if (!hasChrome) return;
  await withNamedLock(CONNECTIONS_LOCK, async () => {
    const book = await readConnections();
    const next: ConnectionBook = {};
    for (const [origin, entry] of Object.entries(book)) {
      next[origin] = { ...entry, accounts: [account] };
    }
    await chromeSet("local", STORAGE_KEYS.connections, next);
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

export async function dropPending(id: string): Promise<void> {
  if (!hasChrome) return;
  await withNamedLock(PENDING_LOCK, async () => {
    const queue = await listPending();
    await chromeSet("local", STORAGE_KEYS.pending, queue.filter((entry) => entry.id !== id));
  });
}

/** Claims expired rows under the same lock as push/drop so startup cannot race a new request. */
export async function takeExpiredPending(now = Date.now()): Promise<DappRequest[]> {
  if (!hasChrome) return [];
  return withNamedLock(PENDING_LOCK, async () => {
    const queue = await listPending();
    const fresh: DappRequest[] = [];
    const expired: DappRequest[] = [];
    for (const entry of queue) {
      const age = now - entry.at;
      if (Number.isFinite(age) && age < DAPP_REQUEST_TIMEOUT_MS) fresh.push(entry);
      else expired.push(entry);
    }
    if (expired.length > 0) await chromeSet("local", STORAGE_KEYS.pending, fresh);
    return expired;
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
    if (
      !id
      || (entry?.result !== undefined && result === undefined)
      || (entry?.error !== undefined && error === undefined)
      || (code !== undefined && !Number.isSafeInteger(code))
      || (result === undefined && error === undefined)
    ) return [];
    return [{ id, result, error, code } satisfies DappResolution];
  });
}

async function writeResolution(resolution: DappResolution): Promise<void> {
  await withNamedLock(RESOLVED_LOCK, async () => {
    const list = await readResolutions();
    const next = [resolution, ...list.filter((entry) => entry.id !== resolution.id)];
    await chromeSet("local", STORAGE_KEYS.resolved, next.slice(0, RESOLVED_KEEP));
  });
  await dropPending(resolution.id);
}

async function consumeResolution(id: string): Promise<void> {
  if (!hasChrome) return;
  await withNamedLock(RESOLVED_LOCK, async () => {
    const list = await readResolutions();
    const next = list.filter((entry) => entry.id !== id);
    if (next.length !== list.length) {
      await chromeSet("local", STORAGE_KEYS.resolved, next);
    }
  });
}

export async function resolveRequest(id: string, result: string): Promise<void> {
  await writeResolution({ id, result });
}

/**
 * Refuses a queued request. The text reaches the page as a JSON-RPC error
 * message, so it stays English like the rest of the protocol surface — the
 * localised wording the user reads lives in the approval window.
 */
export async function rejectRequest(
  id: string,
  error = "User rejected the request",
  code = 4001,
): Promise<void> {
  await writeResolution({ id, code, error });
}

/**
 * Waits for the approval window to answer. The queue entry is dropped on the way
 * out, so an abandoned window cannot leave a request pending forever — and the
 * timeout is what the dapp sees as a rejection.
 */
export function awaitResolution(id: string, timeoutMs = DAPP_REQUEST_TIMEOUT_MS): Promise<DappResolution> {
  return new Promise<DappResolution>((resolve) => {
    let settled = false;
    const finish = (resolution: DappResolution): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
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
      void dropPending(id).finally(() => {
        finish({ id, code: 4001, error: "Request timed out" });
      });
    }, timeoutMs);
    // The window may have answered before this listener was attached.
    void readResolutions().then((list) => {
      const hit = list.find((entry) => entry.id === id);
      if (hit) finish(hit);
    });
  });
}
