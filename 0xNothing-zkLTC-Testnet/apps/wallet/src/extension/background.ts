import { BUILTIN_TOKEN_ADDRESSES } from "../config/assets";
import { LITVM_RPC_URL } from "../config/chain";
import {
  BUILTIN_NETWORKS,
  LITVM_NETWORK,
  MAX_CUSTOM_NETWORKS,
  networkHex,
  networkIdentity,
  normalizeCustomNetworks,
  onNetworkChain,
  resolveNetwork,
  type WalletNetwork,
} from "../config/networks";
import type { AccountsState } from "../core/keyring/vault";
import { chromeGet, chromeRemove, chromeSet } from "../core/platform/chromeStore";
import { withNamedLock } from "../core/platform/locks";
import { AUTOLOCK_ALARM, STORAGE_KEYS } from "../core/platform/storageKeys";
import { parseAddChain, parseWatchAsset, type ProposedChain, type WatchAsset } from "../core/lib/dappProposals";
import {
  awaitResolution,
  connectedAccounts,
  DAPP_REQUEST_TIMEOUT_MS,
  type DappRequest,
  type DappRequestKind,
  DOCUMENT_ID,
  expiryAnswer,
  grantConnection,
  listConnections,
  listPending,
  newRequestId,
  pruneResolutions,
  pushPending,
  rejectRequest,
  resolveActiveAccount,
  revokeConnection,
  tabDocuments,
  takeExpiredPending,
  takeTabRequests,
  watchPending,
} from "../core/services/dapp";
import { isBoundedRpcCall, type RpcCall } from "./protocol";
import { createRpcIngressGate, createRpcSlotQueue } from "./rpcIngress";
import { findApprovalWindowId, shouldForceFocus } from "./approvalWindow";
import {
  notifyTitle,
  parseNotified,
  parseNotifyText,
  receiptOutcome,
  requestNotificationId,
  settledInWrite,
  txMessage,
  txNotificationId,
  unseenRequests,
  type WatchedTx,
  watchedRows,
  withNotified,
} from "./txNotify";
import {
  badgeText,
  canonicalQuantity,
  CONNECT_COOLDOWN_MS,
  coolingDown,
  isAwaiting,
  isLooseQuantity,
  isUserRejection,
  isWalletUiSender as walletUiSender,
  locksWallet,
  noteCooldown,
  parseRequestedChainId,
  tryEndpoints,
} from "./workerRules";

/**
 * The dapp-facing service worker. It holds no key material and never can: the
 * vault is decrypted only inside the wallet UI, so anything that needs a
 * signature is parked in storage and handed to the approval window.
 *
 * Reads are proxied to the selected built-in or saved RPC through an allow-list
 * — an unknown method is refused rather than forwarded, so a page cannot reach
 * node methods the wallet has not vetted. `eth_accounts` answers from the
 * per-origin grant, so a site that was never connected learns nothing.
 *
 * No dynamic `import()` anywhere below: MV3 forbids it in a worker.
 */
const READ_METHODS = new Set([
  "eth_blockNumber",
  "eth_call",
  "eth_createAccessList",
  "eth_estimateGas",
  "eth_feeHistory",
  "eth_gasPrice",
  "eth_getBalance",
  "eth_getBlockByHash",
  "eth_getBlockByNumber",
  "eth_getBlockReceipts",
  "eth_getBlockTransactionCountByHash",
  "eth_getBlockTransactionCountByNumber",
  "eth_getCode",
  "eth_getLogs",
  "eth_getStorageAt",
  "eth_getTransactionByBlockHashAndIndex",
  "eth_getTransactionByBlockNumberAndIndex",
  "eth_getTransactionByHash",
  "eth_getTransactionCount",
  "eth_getTransactionReceipt",
  "eth_maxPriorityFeePerGas",
  "eth_syncing",
  "web3_clientVersion",
]);

interface Answer {
  result?: unknown;
  error?: { code: number; message: string };
}

const providerIngress = createRpcIngressGate({ maxGlobal: 64, maxPerOrigin: 16 });
// Every frame is its own origin, so per-origin limits alone let one tab that frames
// many subdomains hold all 64 global slots and leave every other site "busy".
const tabIngress = createRpcIngressGate({ maxGlobal: 64, maxPerOrigin: 16 });

interface StoredNetworkSettings {
  networkId?: unknown;
  customNetworks?: unknown;
  /** The user's LiteForge RPC; resolveNetwork validates it as the UI does. */
  litvmRpcUrl?: unknown;
}

const APPROVAL_WIDTH = 380;
const APPROVAL_HEIGHT = 660;
const KEEPALIVE_ALARM = "wallet.keepalive";
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const DATA_RE = /^0x(?:[0-9a-fA-F]{2})*$/;
const MAX_HEX_QUANTITY_LENGTH = 66;
const MAX_SIGN_MESSAGE_LENGTH = 1_048_576;
const MAX_RPC_REQUEST_LENGTH = 4_194_304;
const MAX_RPC_RESPONSE_BYTES = 8_388_608;
const rpcSlots = createRpcSlotQueue({ maxInFlight: 8, maxWaiting: 64 });
// Scans that a node answers slowly wait in a narrow lane of their own first. Without
// it, one page running eight log scans held every slot above for the length of the
// timeout, and each other site's balance and call reads queued behind them.
const SLOW_RPC_METHODS: ReadonlySet<string> = new Set(["eth_getLogs", "eth_getBlockReceipts"]);
// Its line holds everything the ingress gates can admit (64), so a scan that was
// let in waits its turn instead of being refused.
const slowRpcSlots = createRpcSlotQueue({ maxInFlight: 2, maxWaiting: 62 });

// Content scripts relay JSON-RPC messages but never need wallet storage. Keep
// the encrypted vault metadata — and especially the in-session AES key — out of
// every untrusted renderer even if a page probes the chrome.storage namespace.
void Promise.all([
  chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" }),
  chrome.storage.session.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" }),
]).catch(() => undefined);

function fail(code: number, message: string): Answer {
  return { error: { code, message } };
}

async function activeAccount(): Promise<string | null> {
  return resolveActiveAccount(await chromeGet<AccountsState>("local", STORAGE_KEYS.accounts));
}

async function activeNetwork(): Promise<WalletNetwork> {
  const saved = await chromeGet<StoredNetworkSettings>("local", STORAGE_KEYS.settings);
  return resolveNetwork(
    saved?.networkId,
    normalizeCustomNetworks(saved?.customNetworks),
    saved?.litvmRpcUrl,
  );
}

async function boundedRpcBody(response: Response): Promise<{
  result?: unknown;
  error?: { code?: number; message?: string };
}> {
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > MAX_RPC_RESPONSE_BYTES) {
    throw new Error("RPC response is too large");
  }
  if (!response.body) {
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > MAX_RPC_RESPONSE_BYTES) throw new Error("RPC response is too large");
    const parsed = JSON.parse(new TextDecoder().decode(buffer)) as unknown;
    if (!isRecord(parsed)) throw new Error("Invalid RPC response");
    return parsed;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_RPC_RESPONSE_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new Error("RPC response is too large");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const parsed = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  if (!isRecord(parsed)) throw new Error("Invalid RPC response");
  return parsed;
}

/** Raw JSON-RPC: the worker deliberately does not build a viem client. */
async function forward(call: RpcCall, network: WalletNetwork): Promise<Answer> {
  const slow = SLOW_RPC_METHODS.has(call.method);
  if (slow && !(await slowRpcSlots.acquire())) return fail(-32005, "The RPC request queue is busy");
  try {
    return await forwardInSlot(call, network);
  } finally {
    if (slow) slowRpcSlots.release();
  }
}

async function forwardInSlot(call: RpcCall, network: WalletNetwork): Promise<Answer> {
  if (!(await rpcSlots.acquire())) return fail(-32005, "The RPC request queue is busy");
  try {
    const payload = JSON.stringify({
      jsonrpc: "2.0",
      id: Date.now(),
      method: call.method,
      params: call.params ?? [],
    });
    if (payload.length > MAX_RPC_REQUEST_LENGTH) {
      return fail(-32600, "RPC request is too large");
    }
    // The user's own LiteForge RPC first, the public endpoint behind it, both in
    // this one slot. The worker only reads: nothing it forwards is a broadcast.
    const urls = [
      network.rpcUrl || LITVM_RPC_URL,
      ...(network.builtin ? network.fallbackRpcUrls ?? [] : []),
    ];
    return await tryEndpoints<Answer>(urls, async (url, timeoutMs) => {
      try {
        const response = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          signal: AbortSignal.timeout(timeoutMs),
          body: payload,
        });
        if (!response.ok) {
          return { answer: fail(-32603, `RPC ${response.status}`), failure: { kind: "http", status: response.status } };
        }
        const body = await boundedRpcBody(response);
        if (body.error) {
          return {
            answer: fail(body.error.code ?? -32603, body.error.message ?? "RPC error"),
            failure: { kind: "rpc", code: body.error.code, message: body.error.message },
          };
        }
        return { answer: { result: body.result ?? null } };
      } catch (error) {
        return {
          answer: fail(-32603, error instanceof Error ? error.message : "RPC unreachable"),
          failure: { kind: "transport" },
        };
      }
    });
  } finally {
    rpcSlots.release();
  }
}
let approvalWindowId: number | undefined;
let approvalWindowTail: Promise<void> = Promise.resolve();
// When a request last pulled the approval window to the front (see shouldForceFocus).
let lastForcedFocusAt = Number.NEGATIVE_INFINITY;
// Requests this worker is waiting on. It lives only in memory on purpose: a worker
// that died forgot them, and the approval window asks before it signs (approval-live).
const awaiting = new Set<string>();
// Connect is refused for a while after a refused connect, by site and by tab, so a
// page that rotates subdomains cannot ask again and again.
const connectCooldown = new Map<string, number>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isAddress(value: unknown): value is string {
  return typeof value === "string" && ADDRESS_RE.test(value);
}

// Leading zeros are accepted here and stripped before queueing (canonicalQuantity),
// so the queue keeps its strict form.
function isQuantity(value: unknown): value is string {
  return typeof value === "string" && value.length <= MAX_HEX_QUANTITY_LENGTH && isLooseQuantity(value);
}

function isData(value: unknown): value is string {
  return typeof value === "string" && value.length <= 2_000_002 && DATA_RE.test(value);
}

function validateTransaction(value: unknown): value is {
  from?: string;
  to?: string;
  value?: string;
  data?: string;
  gas?: string;
  chainId?: string | number;
} {
  if (!isRecord(value)) return false;
  if (value.from !== undefined && !isAddress(value.from)) return false;
  if (value.to !== undefined && !isAddress(value.to)) return false;
  if (value.value !== undefined && !isQuantity(value.value)) return false;
  if (value.gas !== undefined && !isQuantity(value.gas)) return false;
  if (value.data !== undefined && !isData(value.data)) return false;
  // Libraries send a hex quantity; some send a plain number.
  if (value.chainId !== undefined && !isQuantity(value.chainId) && !Number.isSafeInteger(value.chainId)) return false;
  return true;
}

function validMessage(value: unknown): value is string {
  return typeof value === "string" && value.length <= MAX_SIGN_MESSAGE_LENGTH;
}

/**
 * One approval window at a time: a second request joins the queue the window
 * already reads instead of stacking popups on the user's screen.
 */
async function focusOrCreateApproval(id: string): Promise<void> {
  const url = chrome.runtime.getURL(`index.html#/approve?id=${encodeURIComponent(id)}`);
  if (approvalWindowId === undefined) {
    try {
      const approvalRouteUrl = chrome.runtime.getURL("index.html#/approve");
      const windows = await chrome.windows.getAll({ populate: true, windowTypes: ["popup"] });
      approvalWindowId = findApprovalWindowId(windows, approvalRouteUrl);
    } catch {
      // Window discovery is only a de-duplication optimization. Creation below
      // remains the reliable fallback if the browser refuses enumeration.
    }
  }
  if (approvalWindowId !== undefined) {
    try {
      const force = shouldForceFocus(Date.now(), lastForcedFocusAt);
      await chrome.windows.update(approvalWindowId, force ? { focused: true, drawAttention: true } : { drawAttention: true });
      if (force) lastForcedFocusAt = Date.now();
      return;
    } catch {
      approvalWindowId = undefined;
    }
  }
  const created = await chrome.windows.create({
    url,
    type: "popup",
    width: APPROVAL_WIDTH,
    height: APPROVAL_HEIGHT,
    focused: true,
  });
  if (created?.id === undefined) throw new Error("The approval window could not be opened");
  approvalWindowId = created?.id;
  lastForcedFocusAt = Date.now();
}

function openApproval(id: string): Promise<void> {
  const turn = approvalWindowTail.then(() => focusOrCreateApproval(id));
  approvalWindowTail = turn.catch(() => undefined);
  return turn;
}

chrome.windows.onRemoved.addListener((closed) => {
  if (closed !== approvalWindowId) return;
  const closedAt = Date.now();
  approvalWindowId = undefined;
  void listPending().then(async (queue) => {
    await Promise.allSettled(queue
      .filter((request) => request.approvalClaim === undefined && request.at <= closedAt)
      .map((request) => rejectRequest(request.id)));
    await syncKeepAlive().catch(() => undefined);
  }).catch(() => undefined);
});

/** The worker may be evicted while the user is reading; the alarm keeps it up. */
async function keepAlive(): Promise<void> {
  await chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.5 });
}

async function syncKeepAlive(): Promise<void> {
  const queue = await listPending();
  if (queue.length > 0) {
    await keepAlive();
    return;
  }
  await chrome.alarms.clear(KEEPALIVE_ALARM);
  // A request may have arrived between the read and clear; restore the alarm
  // in that case so the worker cannot be evicted while the approval is open.
  if ((await listPending()).length > 0) await keepAlive();
}

/**
 * The vault checks its auto-lock deadline only when a wallet page reads the key, so
 * with every page closed the AES key would stay in session storage until the browser
 * exits. Its alarm drops the key on time; a deadline pushed out since re-arms it.
 */
async function expireSession(): Promise<void> {
  await withNamedLock("session", async () => {
    const deadline = await chromeGet<number>("session", STORAGE_KEYS.sessionDeadline);
    if (typeof deadline === "number" && Number.isSafeInteger(deadline) && deadline > Date.now()) {
      await chrome.alarms.create(AUTOLOCK_ALARM, { when: deadline });
      return;
    }
    await Promise.all([
      chromeRemove("session", STORAGE_KEYS.session),
      chromeRemove("session", STORAGE_KEYS.sessionDeadline),
    ]);
  });
}

/**
 * Locking the computer locks the wallet. Without it the AES key stayed in session
 * storage until the auto-lock deadline (up to a day), for whoever unlocks the OS
 * account next. Same lock and same keys as the vault's own lock; the open wallet
 * pages see the session go and show the unlock screen.
 */
async function lockSession(): Promise<void> {
  await withNamedLock("session", async () => {
    await Promise.all([
      chromeRemove("session", STORAGE_KEYS.session),
      chromeRemove("session", STORAGE_KEYS.sessionDeadline),
    ]);
    await chrome.alarms.clear(AUTOLOCK_ALARM);
  });
}

chrome.idle.onStateChanged.addListener((state) => {
  if (locksWallet(state)) void lockSession().catch(() => undefined);
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === AUTOLOCK_ALARM) {
    void expireSession().catch(() => undefined);
    return;
  }
  if (alarm.name === TX_WATCH_ALARM) {
    void checkWatchedTxs().catch(() => undefined);
    return;
  }
  if (alarm.name !== KEEPALIVE_ALARM) return;
  void listPending().then((queue) => {
    if (queue.length === 0) void chrome.alarms.clear(KEEPALIVE_ALARM);
  });
  void noticeUnseenRequests().catch(() => undefined);
});
/**
 * Queues one approval and waits for the window to answer. The request carries
 * the origin the content script reported, so what the user reads is the site
 * that actually asked.
 */
async function askUser(params: {
  kind: DappRequestKind;
  origin: string;
  title?: string;
  networkId?: string;
  networkIdentity?: string;
  targetNetworkId?: string;
  account?: string;
  tx?: DappRequest["tx"];
  message?: string;
  asset?: WatchAsset;
  chain?: ProposedChain;
  tabId?: number;
  documentId?: string;
}): Promise<Answer> {
  const id = newRequestId();
  const at = Date.now();
  // Before the row exists: an open approval window sees it through storage at once
  // and may ask whether it is live before openApproval below has returned.
  awaiting.add(id);
  try {
    const admission = await pushPending({
      id,
      origin: params.origin,
      title: params.title,
      kind: params.kind,
      at,
      networkId: params.networkId,
      networkIdentity: params.networkIdentity,
      targetNetworkId: params.targetNetworkId,
      account: params.account as DappRequest["account"],
      tx: params.tx,
      message: params.message,
      ...(params.asset === undefined ? {} : { asset: params.asset }),
      ...(params.chain === undefined ? {} : { chain: params.chain }),
      ...(params.tabId === undefined ? {} : { tabId: params.tabId }),
      ...(params.documentId === undefined ? {} : { documentId: params.documentId }),
    });
    if (!admission.accepted) {
      const message = admission.reason === "duplicate-connect"
        ? "A connection request from this site is already pending"
        : admission.reason === "duplicate-asset"
          ? "This token is already waiting for approval"
          : admission.reason === "duplicate-network"
            ? "A network proposal from this site is already pending"
            : admission.reason === "origin-limit"
          ? "Too many requests from this site are awaiting approval"
          : admission.reason === "tab-limit"
            ? "Too many requests from this tab are awaiting approval"
            : admission.reason === "connect-limit"
              ? "Too many connection requests are awaiting approval"
              : "The wallet approval queue is full";
      return fail(-32002, message);
    }
    // A row a window had claimed may have been broadcast: never answered as 4001.
    await Promise.allSettled(admission.expiredIds.map((expiredId) => {
      const answer = expiryAnswer(admission.maybeSentIds.includes(expiredId) ? { approvalClaim: expiredId } : {});
      return rejectRequest(expiredId, answer.error, answer.code);
    }));
    await keepAlive().catch(() => undefined);
    try {
      await openApproval(id);
    } catch (error) {
      await rejectRequest(id, "The approval window could not be opened", 4900).catch(() => undefined);
      return fail(4900, error instanceof Error ? error.message : "The approval window could not be opened");
    }
    // Timed from the row's own `at`, the clock the claim and signing limits use,
    // not from when the window finished opening.
    const resolution = await awaitResolution(id, Math.max(0, at + DAPP_REQUEST_TIMEOUT_MS - Date.now()));
    await syncKeepAlive().catch(() => undefined);
    if (resolution.result === undefined) {
      return fail(resolution.code ?? 4001, resolution.error ?? "User rejected the request");
    }
    return { result: resolution.result };
  } finally {
    awaiting.delete(id);
  }
}

/**
 * Answers the unclaimed requests of a tab whose page is gone (closed, reloaded or
 * navigated away). Nobody is left to take their answer, and a stale connect would
 * refuse that tab's next one with -32002. Claimed rows are executing and stay.
 */
async function rejectTabRequests(tabId: number, reason: string, deadDocuments?: ReadonlySet<string>): Promise<void> {
  const gone = await takeTabRequests(tabId, deadDocuments);
  if (gone.length === 0) return;
  await Promise.allSettled(gone.map((request) => rejectRequest(request.id, reason)));
  await syncKeepAlive().catch(() => undefined);
}

/**
 * Asks each document a tab's rows name whether it is still there; the content
 * script answers. Only a document that cannot be reached is counted gone.
 */
async function deadTabDocuments(tabId: number): Promise<Set<string>> {
  const dead = new Set<string>();
  await Promise.all(tabDocuments(await listPending(), tabId).map(async (documentId) => {
    try {
      await chrome.tabs.sendMessage(tabId, { kind: "provider-alive" }, { documentId });
    } catch {
      dead.add(documentId);
    }
  }));
  return dead;
}

chrome.tabs.onRemoved.addListener((tabId) => {
  // The per-origin cooldown stays with the site that was refused; the tab's goes.
  connectCooldown.delete(`tab:${tabId}`);
  void rejectTabRequests(tabId, "The page that asked was closed").catch(() => undefined);
});
// Status "loading" also fires for a pushState or replaceState in many Chromium
// builds, so the status alone does not mean the page is gone: each row's document
// is asked. On "loading" the old document may still be up, so "complete" asks
// again. Neither needs the "tabs" permission.
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status !== "loading" && info.status !== "complete") return;
  if (info.status === "loading") connectCooldown.delete(`tab:${tabId}`);
  void deadTabDocuments(tabId)
    .then((dead) => rejectTabRequests(tabId, "The page that asked reloaded", dead))
    .catch(() => undefined);
});

function chainRequested(params: unknown[] | undefined): bigint | null {
  const first = params?.[0];
  return parseRequestedChainId(isRecord(first) ? first.chainId : undefined);
}

async function savedNetworkForChain(requestedChainId: bigint): Promise<WalletNetwork | null> {
  const saved = await chromeGet<StoredNetworkSettings>("local", STORAGE_KEYS.settings);
  const custom = normalizeCustomNetworks(saved?.customNetworks);
  return [...BUILTIN_NETWORKS, ...custom].find(
    (entry) => BigInt(entry.chainId) === requestedChainId,
  ) ?? null;
}

async function switchNetwork(requestedChainId: bigint): Promise<Answer> {
  // The wallet UI writes settings under this same lock; an unlocked read-modify-write
  // here could drop a custom network or theme saved at the same moment.
  return withNamedLock("settings", async () => {
    const saved = await chromeGet<StoredNetworkSettings>("local", STORAGE_KEYS.settings);
    const custom = normalizeCustomNetworks(saved?.customNetworks);
    const network = [...BUILTIN_NETWORKS, ...custom].find(
      (entry) => BigInt(entry.chainId) === requestedChainId,
    );
    if (!network) return fail(4902, "This network is not saved in the wallet");
    if (saved?.networkId === network.id) return { result: null };
    await chromeSet("local", STORAGE_KEYS.settings, {
      ...(saved ?? {}),
      networkId: network.id,
      customNetworks: custom,
    });
    void broadcast("chainChanged");
    return { result: null };
  });
}

/**
 * `a` is `unknown` on purpose: the signer slot of `personal_sign` and of the
 * typed-data methods is shape-checked but not type-checked upstream, so a page
 * can put an object there. Anything that is not a string simply does not match
 * the connected account.
 */
function sameAccount(a: unknown, b: string | undefined): boolean {
  return typeof a === "string" && !!b && a.toLowerCase() === b.toLowerCase();
}

const PROVIDER_EVENTS = new Set(["accountsChanged", "chainChanged"]);

function senderOrigin(sender: chrome.runtime.MessageSender): string | undefined {
  if (sender.origin) return sender.origin;
  if (!sender.url) return undefined;
  try {
    return new URL(sender.url).origin;
  } catch {
    return undefined;
  }
}

function providerSenderOrigin(sender: chrome.runtime.MessageSender): string | undefined {
  if (sender.id !== chrome.runtime.id || sender.tab === undefined || !sender.url) return undefined;
  const raw = senderOrigin(sender);
  if (!raw) return undefined;
  try {
    const origin = new URL(raw);
    const page = new URL(sender.url);
    if (origin.protocol !== "http:" && origin.protocol !== "https:") return undefined;
    if (page.protocol !== "http:" && page.protocol !== "https:") return undefined;
    return page.origin === origin.origin ? origin.origin : undefined;
  } catch {
    return undefined;
  }
}

// A wallet opened in a tab and the approval window both have a sender.tab; only the
// extension URL tells them from a content script, so that is what is checked.
function isWalletUiSender(sender: chrome.runtime.MessageSender): boolean {
  return walletUiSender(sender, chrome.runtime.id);
}
/**
 * Provider events are a ping and a pull. The ping reaches every frame of every tab,
 * so it carries the event name and nothing else: no address, no list of sites. A
 * frame that uses the provider then asks for its own state (provider-state), which
 * is answered for the origin the browser reports, exactly as eth_accounts is.
 */
async function broadcast(name: string): Promise<void> {
  const tabs = await chrome.tabs.query({});
  await Promise.all(tabs.map(async (tab) => {
    if (tab.id === undefined) return;
    try {
      await chrome.tabs.sendMessage(tab.id, { kind: "provider-event", name });
    } catch {
      // No content script in that tab; nothing to tell.
    }
  }));
}

/**
 * What a frame's provider should report: the same answers as eth_chainId and
 * eth_accounts. The chain goes only to a site that holds a connection: many dapps
 * reload on chainChanged, and an unrelated open tab must not reload on a switch.
 */
async function providerState(origin: string): Promise<{ chainId?: string; accounts: string[] }> {
  const [network, active, connections] = await Promise.all([activeNetwork(), activeAccount(), listConnections()]);
  const accounts = await connectedAccounts(origin, active);
  return connections.some((entry) => entry.origin === origin)
    ? { chainId: networkHex(network.chainId), accounts }
    : { accounts };
}

async function handle(call: RpcCall, origin: string, title?: string, tabId?: number, documentId?: string): Promise<Answer> {
  const method = call.method;
  // Only wallet_watchAsset may carry object params (protocol.ts); it reads
  // call.params itself, every other method takes the array.
  const params = Array.isArray(call.params) ? call.params : [];
  const network = await activeNetwork();

  if (method === "eth_chainId") return { result: networkHex(network.chainId) };
  if (method === "net_version") return { result: String(network.chainId) };
  // Public chain data needs no permission — but it does need to be on the list.
  if (READ_METHODS.has(method)) return forward(call, network);

  // A site sees the active account only if the user connected that account to it;
  // after a switch to an account it was not given, it sees none until it asks.
  const active = await activeAccount();
  if (method === "eth_accounts") return { result: await connectedAccounts(origin, active) };
  if (method === "wallet_getPermissions") {
    const granted = await connectedAccounts(origin, active);
    return { result: granted.length > 0 ? [{ parentCapability: "eth_accounts" }] : [] };
  }

  if (method === "eth_requestAccounts" || method === "wallet_requestPermissions") {
    const permission = [{ parentCapability: "eth_accounts" }];
    const granted = await connectedAccounts(origin, active);
    if (granted.length > 0) {
      return { result: method === "eth_requestAccounts" ? granted : permission };
    }
    const account = active;
    if (!account) return fail(4100, "No wallet set up in the extension");
    const now = Date.now();
    const tabKey = tabId === undefined ? undefined : `tab:${tabId}`;
    if (
      coolingDown(connectCooldown, `origin:${origin}`, now)
      || (tabKey !== undefined && coolingDown(connectCooldown, tabKey, now))
    ) {
      return fail(4001, "User rejected the request");
    }
    const answer = await askUser({ kind: "connect", origin, title, account, networkId: network.id, networkIdentity: networkIdentity(network), tabId, documentId });
    if (answer.error) {
      // Only the user's own refusal (Reject, or closing the window) cools down: a
      // connect answered because its page reloaded must not block the new page.
      if (isUserRejection(answer.error)) {
        const until = Date.now() + CONNECT_COOLDOWN_MS;
        noteCooldown(connectCooldown, `origin:${origin}`, until);
        if (tabKey !== undefined) noteCooldown(connectCooldown, tabKey, until);
      }
      return answer;
    }
    const approved = String(answer.result);
    await grantConnection(origin, [approved as `0x${string}`]);
    void broadcast("accountsChanged");
    return { result: method === "eth_requestAccounts" ? [approved] : permission };
  }
  if (method === "wallet_revokePermissions") {
    await revokeConnection(origin);
    void broadcast("accountsChanged");
    return { result: null };
  }
  const granted = await connectedAccounts(origin, active);
  const account = granted[0];
  if (!account) return fail(4100, "This site is not connected to the wallet");

  if (method === "wallet_watchAsset") {
    const parsed = parseWatchAsset(call.params, BigInt(network.chainId));
    if ("error" in parsed) return fail(-32602, parsed.error);
    // Every wallet lists the built-in tokens, so answering at once tells the page
    // nothing. An imported token still asks: an instant true would let a
    // connected page probe which tokens the user imported.
    if (network.builtin && BUILTIN_TOKEN_ADDRESSES.has(parsed.asset.address)) return { result: true };
    const answer = await askUser({
      kind: "watch-asset",
      origin,
      title,
      account,
      asset: parsed.asset,
      networkId: network.id,
      networkIdentity: networkIdentity(network),
      tabId,
      documentId,
    });
    return answer.error ? answer : { result: true };
  }

  if (method === "wallet_addEthereumChain") {
    const parsed = parseAddChain(params);
    if ("error" in parsed) return fail(-32602, parsed.error);
    // A chain the wallet already has (the built-in one or a saved profile) adds
    // nothing and is never replaced; the page asks to switch separately.
    if (await savedNetworkForChain(BigInt(parsed.chain.chainId))) return { result: null };
    const saved = await chromeGet<StoredNetworkSettings>("local", STORAGE_KEYS.settings);
    if (normalizeCustomNetworks(saved?.customNetworks).length >= MAX_CUSTOM_NETWORKS) {
      return fail(-32603, "The wallet holds as many networks as it can; remove one in Settings");
    }
    // Approving saves the network only: it never switches to it.
    const answer = await askUser({
      kind: "add-network",
      origin,
      title,
      account,
      chain: parsed.chain,
      networkId: network.id,
      networkIdentity: networkIdentity(network),
      tabId,
      documentId,
    });
    return answer.error ? answer : { result: null };
  }

  if (method === "wallet_switchEthereumChain") {
    const requested = chainRequested(params);
    if (requested === null) return fail(-32602, "A chainId is required");
    const target = await savedNetworkForChain(requested);
    // 4902 tells the caller to propose the network with wallet_addEthereumChain.
    if (!target) return fail(4902, "This network is not saved in the wallet");
    if (target.id === network.id) return { result: null };
    const answer = await askUser({
      kind: "switch-network",
      origin,
      title,
      account,
      networkId: network.id,
      networkIdentity: networkIdentity(network),
      targetNetworkId: target.id,
      tabId,
      documentId,
    });
    if (answer.error) return answer;
    return switchNetwork(requested);
  }

  if (method === "eth_sendTransaction") {
    const raw = params[0];
    if (!validateTransaction(raw)) return fail(-32602, "Invalid transaction parameters");
    if (raw.from && !sameAccount(raw.from, account)) {
      return fail(4100, "The from address does not match the connected account");
    }
    // The signer uses the active network, so a call built for another chain would
    // hit whatever sits at the same address here.
    if (raw.chainId !== undefined && BigInt(raw.chainId) !== BigInt(network.chainId)) {
      return fail(-32602, "The transaction chainId does not match the active network");
    }
    return askUser({
      kind: "transaction",
      origin,
      title,
      account,
      networkId: network.id,
      networkIdentity: networkIdentity(network),
      tx: {
        to: raw.to as `0x${string}` | undefined,
        value: raw.value === undefined ? undefined : canonicalQuantity(raw.value),
        data: raw.data as `0x${string}` | undefined,
        gas: raw.gas === undefined ? undefined : canonicalQuantity(raw.gas),
      },
      tabId,
      documentId,
    });
  }
  if (method === "personal_sign" || method === "eth_sign") {
    // personal_sign is [message, address]; the older eth_sign is the reverse.
    const [first, second] = params as [string | undefined, string | undefined];
    const message = method === "personal_sign" ? first : second;
    const signer = method === "personal_sign" ? second : first;
    if (!validMessage(message)) return fail(-32602, "Invalid message to sign");
    if (signer && !sameAccount(signer, account)) {
      return fail(4100, "The signing address does not match the connected account");
    }
    return askUser({ kind: "sign", origin, title, account, message, networkId: network.id, networkIdentity: networkIdentity(network), tabId, documentId });
  }

  if (method === "eth_signTypedData_v4" || method === "eth_signTypedData_v3") {
    const [signer, payload] = params as [string | undefined, unknown];
    if (signer && !sameAccount(signer, account)) {
      return fail(4100, "The signing address does not match the connected account");
    }
    let message: string | undefined;
    try {
      message = typeof payload === "string" ? payload : JSON.stringify(payload);
    } catch {
      message = undefined;
    }
    if (!validMessage(message) || message.length === 0) return fail(-32602, "Invalid typed data");
    return askUser({ kind: "sign-typed", origin, title, account, message, networkId: network.id, networkIdentity: networkIdentity(network), tabId, documentId });
  }

  return fail(-32601, `The wallet does not support ${method}`);
}

/**
 * `sender.origin` is what the browser saw, not what the page said, so a hostile
 * frame cannot borrow another site's grant. Anything without an http(s) origin —
 * a file:// page, another extension — is refused outright.
 */
chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  const request = message as
    | { kind?: string; call?: RpcCall; name?: string; id?: unknown }
    | null;

  if (request?.kind === "provider-request" && request.call) {
    if (!isBoundedRpcCall(request.call)) {
      sendResponse(fail(-32600, "Invalid request"));
      return false;
    }
    const origin = providerSenderOrigin(sender);
    if (!origin) {
      sendResponse(fail(4100, "Unsupported origin"));
      return false;
    }
    const releaseTab = tabIngress.tryAcquire(String(sender.tab?.id ?? origin));
    const release = releaseTab ? providerIngress.tryAcquire(origin) : null;
    if (!releaseTab || !release) {
      releaseTab?.();
      sendResponse(fail(-32005, "The wallet request queue is busy"));
      return false;
    }
    // The tab title belongs to the top page; an embedded frame asking to connect or
    // sign must be shown by its own origin, not under the host site's name.
    // sender.tab.id is set by the browser; a page cannot choose it.
    const tabId = sender.tab?.id !== undefined && Number.isSafeInteger(sender.tab.id) && sender.tab.id >= 0
      ? sender.tab.id
      : undefined;
    // So is sender.documentId: it names the asking frame's document, which a page
    // navigation replaces and a pushState keeps.
    const documentId = typeof sender.documentId === "string" && DOCUMENT_ID.test(sender.documentId)
      ? sender.documentId
      : undefined;
    void handle(request.call, origin, sender.frameId === 0 ? sender.tab?.title : undefined, tabId, documentId)
      .catch((error: unknown) => fail(-32603, error instanceof Error ? error.message : "Wallet request failed"))
      .then(sendResponse)
      .finally(() => {
        release();
        releaseTab();
      });
    return true;
  }

  // The approval window asks, before it claims a request, whether this worker still
  // waits for it. Sending the message also wakes a worker that died, whose startup
  // sweep then answers the rows its predecessor left.
  if (request?.kind === "approval-live" && isWalletUiSender(sender)) {
    sendResponse({ live: isAwaiting(awaiting, request.id) });
    return false;
  }

  // A content script pulls its frame's state after a ping. The origin comes from the
  // browser, as for provider-request, so a frame learns only what it could ask.
  if (request?.kind === "provider-state") {
    const origin = providerSenderOrigin(sender);
    if (!origin) {
      sendResponse(fail(4100, "Unsupported origin"));
      return false;
    }
    void providerState(origin)
      .then((state) => sendResponse({ result: state }))
      .catch((error: unknown) => sendResponse(fail(-32603, error instanceof Error ? error.message : "State unavailable")));
    return true;
  }

  // The wallet UI asks the worker to ping the pages. It names the event only: what
  // each site may see is worked out per site when it pulls, never sent from here.
  if (
    request?.kind === "wallet-event"
    && typeof request.name === "string"
    && PROVIDER_EVENTS.has(request.name)
    && isWalletUiSender(sender)
  ) {
    void broadcast(request.name)
      .then(() => sendResponse({ result: null }))
      .catch((error: unknown) => sendResponse(fail(-32603, error instanceof Error ? error.message : "Event failed")));
    return true;
  }

  return false;
});

/**
 * Opt-in notifications (Settings > Appearance; the permission is optional and asked
 * for at that click). The worker tells the user when one of the wallet's own
 * pending transactions confirms or fails, and when a dapp request has waited
 * unseen. Its alarm exists only while the switch is on and a recent pending row
 * is left, so nothing is read while nothing is pending. It reads receipts and
 * never writes history; History keeps settling its own rows.
 */
const TX_WATCH_ALARM = "wallet.txwatch";

async function notificationsEnabled(): Promise<boolean> {
  if (typeof chrome.notifications?.create !== "function") return false;
  const saved = await chromeGet<{ notifications?: unknown }>("local", STORAGE_KEYS.settings);
  return saved?.notifications === true;
}

async function notifyState() {
  const [notified, text] = await Promise.all([
    chromeGet<unknown>("local", STORAGE_KEYS.notified),
    chromeGet<unknown>("local", STORAGE_KEYS.notifyText),
  ]);
  return { notified: parseNotified(notified), text: parseNotifyText(text) };
}

/** Shows one notification unless that id was shown before; the id is noted first. */
async function showNotification(id: string, title: string, message: string): Promise<void> {
  await withNamedLock("notified", async () => {
    const shown = parseNotified(await chromeGet<unknown>("local", STORAGE_KEYS.notified));
    if (shown.includes(id)) return;
    await chromeSet("local", STORAGE_KEYS.notified, withNotified(shown, id));
    await chrome.notifications.create(id, {
      type: "basic",
      iconUrl: chrome.runtime.getURL("icons/icon-128.png"),
      title,
      message,
      priority: 0,
    });
  });
}

/** Rows to watch, each with the saved network it was sent on (old rows: the built-in one). */
async function watchedTxs(): Promise<{ tx: WatchedTx; network: WalletNetwork }[]> {
  const [book, settings, state] = await Promise.all([
    chromeGet<unknown>("local", STORAGE_KEYS.history),
    chromeGet<StoredNetworkSettings>("local", STORAGE_KEYS.settings),
    notifyState(),
  ]);
  const customs = normalizeCustomNetworks(settings?.customNetworks);
  // LiteForge with the user's own RPC when one is set, as every wallet surface
  // reads it: the public endpoint may be the one that is down.
  const networks = [resolveNetwork(LITVM_NETWORK.id, customs, settings?.litvmRpcUrl), ...customs];
  // Replacing a custom network's RPC gives it a new id; a row sent before that
  // keeps the old one and is matched by its chain.
  const networkOf = (id: string | undefined) => {
    const key = id ?? LITVM_NETWORK.id;
    return networks.find((entry) => entry.id === key) ?? networks.find((entry) => onNetworkChain(key, entry.id));
  };
  return watchedRows(book, Date.now(), state.notified, (id) => networkOf(id) !== undefined)
    .flatMap((tx) => {
      const network = networkOf(tx.networkId);
      return network ? [{ tx, network }] : [];
    });
}

async function syncTxWatch(): Promise<void> {
  const watched = (await notificationsEnabled()) ? await watchedTxs() : [];
  if (watched.length === 0) {
    await chrome.alarms.clear(TX_WATCH_ALARM);
    return;
  }
  // Re-creating would push the first tick back on every history write.
  if (!(await chrome.alarms.get(TX_WATCH_ALARM))) {
    await chrome.alarms.create(TX_WATCH_ALARM, { periodInMinutes: 0.5 });
  }
}

async function checkWatchedTxs(): Promise<void> {
  if (await notificationsEnabled()) {
    const [watched, { text }] = await Promise.all([watchedTxs(), notifyState()]);
    for (const { tx, network } of watched) {
      const answer = await forward({ method: "eth_getTransactionReceipt", params: [tx.hash] }, network);
      const ok = answer.error === undefined ? receiptOutcome(answer.result) : null;
      if (ok === null) continue;
      await showNotification(
        txNotificationId(tx.hash),
        notifyTitle(text, ok ? "notif.confirmed" : "notif.failed"),
        txMessage(tx.row, text),
      );
    }
  }
  await syncTxWatch();
}

/** A wallet page settled rows itself: the outcome is told the same way. */
async function noticeSettledWrite(before: unknown, after: unknown): Promise<void> {
  if (!(await notificationsEnabled())) return;
  const { notified, text } = await notifyState();
  for (const { row, ok } of settledInWrite(before, after, Date.now(), notified)) {
    await showNotification(
      txNotificationId(String(row.hash)),
      notifyTitle(text, ok ? "notif.confirmed" : "notif.failed"),
      txMessage(row, text),
    );
  }
}

async function approvalWindowFocused(): Promise<boolean> {
  try {
    const windows = await chrome.windows.getAll({ populate: true, windowTypes: ["popup"] });
    const id = findApprovalWindowId(windows, chrome.runtime.getURL("index.html#/approve"));
    return windows.some((entry) => entry.id === id && entry.focused);
  } catch {
    return false;
  }
}

/** Runs on the keepalive tick, which exists only while the queue is not empty. */
async function noticeUnseenRequests(): Promise<void> {
  if (!(await notificationsEnabled())) return;
  const queue = (await listPending()).filter((request) => request.approvalClaim === undefined);
  const { notified, text } = await notifyState();
  const unseen = unseenRequests(queue, Date.now(), notified);
  if (unseen.length === 0 || await approvalWindowFocused()) return;
  for (const request of unseen) {
    // No origin and no page text: the worker spans incognito windows, and a
    // notification outlives that session in the system's notification centre.
    await showNotification(requestNotificationId(request.id), chrome.runtime.getManifest().name, notifyTitle(text, "notif.waiting"));
  }
}

let notificationClicks = false;
/** Listened to from the start when the permission is held, else once it is granted. */
function listenToNotificationClicks(): void {
  if (notificationClicks || typeof chrome.notifications?.onClicked?.addListener !== "function") return;
  notificationClicks = true;
  chrome.notifications.onClicked.addListener((id) => {
    void chrome.notifications.clear(id).catch(() => undefined);
    if (id.startsWith("req:")) {
      void listPending().then((queue) => (queue[0] ? openApproval(queue[0].id) : undefined)).catch(() => undefined);
      return;
    }
    void chrome.tabs.create({ url: chrome.runtime.getURL("index.html?surface=tab#/history") }).catch(() => undefined);
  });
}

listenToNotificationClicks();
chrome.permissions?.onAdded?.addListener(() => {
  listenToNotificationClicks();
  void syncTxWatch().catch(() => undefined);
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  const history = changes[STORAGE_KEYS.history];
  if (history) void noticeSettledWrite(history.oldValue, history.newValue).catch(() => undefined);
  if (history || changes[STORAGE_KEYS.settings]) void syncTxWatch().catch(() => undefined);
});
void syncTxWatch().catch(() => undefined);

// Rows queued before this worker started that no approval window claimed lost their
// page's reply channel with the old worker, so they are rejected rather than shown
// again; a claimed row is still finishing and keeps its window. Stale rows are taken
// under the queue lock so a request arriving now cannot be mistaken for one of them.
/**
 * The toolbar badge counts the requests waiting for approval. Every queue write,
 * from this worker or from an approval window, passes through storage, so the
 * change listener keeps the badge right; the docs do not promise a badge outlives
 * a worker restart, so the startup sweep below sets it again. Cosmetic only: a
 * browser that refuses it changes nothing else.
 */
function showQueueCount(count: number): void {
  void chrome.action?.setBadgeText({ text: badgeText(count) })?.catch(() => undefined);
}

try {
  void chrome.action?.setBadgeBackgroundColor({ color: "#c9cdd2" })?.catch(() => undefined);
  void chrome.action?.setBadgeTextColor?.({ color: "#0b0c0e" })?.catch(() => undefined);
} catch {
  // An older or stripped-down Chromium: the default badge colours stand.
}
watchPending((queue) => showQueueCount(queue.length));

const WORKER_STARTED_AT = Date.now();
void takeExpiredPending(Date.now(), WORKER_STARTED_AT).then(async (expired) => {
  await pruneResolutions().catch(() => undefined);
  await Promise.allSettled(expired.map((request) => {
    const answer = expiryAnswer(request);
    return rejectRequest(request.id, answer.error, answer.code);
  }));
  const queue = await listPending();
  showQueueCount(queue.length);
  const first = queue[0];
  if (!first) {
    await syncKeepAlive();
    return;
  }
  await keepAlive().catch(() => undefined);
  await openApproval(first.id);
}).catch(() => undefined);
