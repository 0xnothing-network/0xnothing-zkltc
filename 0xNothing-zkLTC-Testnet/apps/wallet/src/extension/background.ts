import { LITVM_RPC_URL } from "../config/chain";
import {
  BUILTIN_NETWORKS,
  networkHex,
  normalizeCustomNetworks,
  resolveNetwork,
  type WalletNetwork,
} from "../config/networks";
import type { AccountsState } from "../core/keyring/vault";
import { chromeGet, chromeSet } from "../core/platform/chromeStore";
import { STORAGE_KEYS } from "../core/platform/storageKeys";
import {
  awaitResolution,
  connectedAccounts,
  type DappRequest,
  type DappRequestKind,
  grantConnection,
  listPending,
  listConnections,
  newRequestId,
  pushPending,
  rejectRequest,
  revokeConnection,
  takeExpiredPending,
} from "../core/services/dapp";
import { isBoundedRpcCall, type RpcCall } from "./protocol";
import { createRpcIngressGate } from "./rpcIngress";
import { findApprovalWindowId } from "./approvalWindow";

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

interface StoredNetworkSettings {
  networkId?: unknown;
  customNetworks?: unknown;
}

const APPROVAL_WIDTH = 380;
const APPROVAL_HEIGHT = 660;
const KEEPALIVE_ALARM = "wallet.keepalive";
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const DATA_RE = /^0x(?:[0-9a-fA-F]{2})*$/;
const QUANTITY_RE = /^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/;
const MAX_HEX_QUANTITY_LENGTH = 66;
const MAX_SIGN_MESSAGE_LENGTH = 1_048_576;
const MAX_RPC_REQUEST_LENGTH = 4_194_304;
const MAX_RPC_RESPONSE_BYTES = 8_388_608;
const MAX_RPC_IN_FLIGHT = 8;
const MAX_RPC_WAITING = 64;
let rpcInFlight = 0;
const rpcWaiters: Array<() => void> = [];

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
  const state = await chromeGet<AccountsState>("local", STORAGE_KEYS.accounts);
  return state?.active ?? null;
}

async function activeNetwork(): Promise<WalletNetwork> {
  const saved = await chromeGet<StoredNetworkSettings>("local", STORAGE_KEYS.settings);
  return resolveNetwork(
    saved?.networkId,
    normalizeCustomNetworks(saved?.customNetworks),
  );
}

async function acquireRpcSlot(): Promise<boolean> {
  if (rpcInFlight < MAX_RPC_IN_FLIGHT) {
    rpcInFlight += 1;
    return true;
  }
  if (rpcWaiters.length >= MAX_RPC_WAITING) return false;
  await new Promise<void>((resolve) => rpcWaiters.push(resolve));
  return true;
}

function releaseRpcSlot(): void {
  const next = rpcWaiters.shift();
  if (next) {
    // Ownership transfers directly; keeping the count unchanged prevents a
    // request arriving in this microtask gap from exceeding the concurrency cap.
    next();
    return;
  }
  rpcInFlight = Math.max(0, rpcInFlight - 1);
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
  if (!(await acquireRpcSlot())) return fail(-32005, "The RPC request queue is busy");
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
    const response = await fetch(network.rpcUrl || LITVM_RPC_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: AbortSignal.timeout(15_000),
      body: payload,
    });
    if (!response.ok) return fail(-32603, `RPC ${response.status}`);
    const body = await boundedRpcBody(response);
    if (body.error) {
      return fail(body.error.code ?? -32603, body.error.message ?? "RPC error");
    }
    return { result: body.result ?? null };
  } catch (error) {
    return fail(-32603, error instanceof Error ? error.message : "RPC unreachable");
  } finally {
    releaseRpcSlot();
  }
}
let approvalWindowId: number | undefined;
let approvalWindowTail: Promise<void> = Promise.resolve();

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isAddress(value: unknown): value is string {
  return typeof value === "string" && ADDRESS_RE.test(value);
}

function isQuantity(value: unknown): value is string {
  return typeof value === "string" && value.length <= MAX_HEX_QUANTITY_LENGTH && QUANTITY_RE.test(value);
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
} {
  if (!isRecord(value)) return false;
  if (value.from !== undefined && !isAddress(value.from)) return false;
  if (value.to !== undefined && !isAddress(value.to)) return false;
  if (value.value !== undefined && !isQuantity(value.value)) return false;
  if (value.gas !== undefined && !isQuantity(value.gas)) return false;
  if (value.data !== undefined && !isData(value.data)) return false;
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
      await chrome.windows.update(approvalWindowId, { focused: true, drawAttention: true });
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

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== KEEPALIVE_ALARM) return;
  void listPending().then((queue) => {
    if (queue.length === 0) void chrome.alarms.clear(KEEPALIVE_ALARM);
  });
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
  targetNetworkId?: string;
  account?: string;
  tx?: DappRequest["tx"];
  message?: string;
}): Promise<Answer> {
  const id = newRequestId();
  const admission = await pushPending({
    id,
    origin: params.origin,
    title: params.title,
    kind: params.kind,
    at: Date.now(),
    networkId: params.networkId,
    targetNetworkId: params.targetNetworkId,
    account: params.account as DappRequest["account"],
    tx: params.tx,
    message: params.message,
  });
  if (!admission.accepted) {
    const message = admission.reason === "duplicate-connect"
      ? "A connection request from this site is already pending"
      : admission.reason === "origin-limit"
        ? "Too many requests from this site are awaiting approval"
        : "The wallet approval queue is full";
    return fail(-32002, message);
  }
  await Promise.allSettled(admission.expiredIds.map((expiredId) =>
    rejectRequest(expiredId, "Request expired")
  ));
  await keepAlive().catch(() => undefined);
  try {
    await openApproval(id);
  } catch (error) {
    await rejectRequest(id, "The approval window could not be opened", 4900).catch(() => undefined);
    return fail(4900, error instanceof Error ? error.message : "The approval window could not be opened");
  }
  const resolution = await awaitResolution(id);
  await syncKeepAlive().catch(() => undefined);
  if (resolution.result === undefined) {
    return fail(resolution.code ?? 4001, resolution.error ?? "User rejected the request");
  }
  return { result: resolution.result };
}

function chainRequested(params: unknown[] | undefined): string | undefined {
  const first = params?.[0] as { chainId?: string } | undefined;
  return first?.chainId?.toLowerCase();
}

async function savedNetworkForChain(requestedChainId: string): Promise<WalletNetwork | null> {
  const saved = await chromeGet<StoredNetworkSettings>("local", STORAGE_KEYS.settings);
  const custom = normalizeCustomNetworks(saved?.customNetworks);
  return [...BUILTIN_NETWORKS, ...custom].find(
    (entry) => networkHex(entry.chainId).toLowerCase() === requestedChainId,
  ) ?? null;
}

async function switchNetwork(requestedChainId: string): Promise<Answer> {
  const saved = await chromeGet<StoredNetworkSettings>("local", STORAGE_KEYS.settings);
  const custom = normalizeCustomNetworks(saved?.customNetworks);
  const network = [...BUILTIN_NETWORKS, ...custom].find(
    (entry) => networkHex(entry.chainId).toLowerCase() === requestedChainId,
  );
  if (!network) return fail(4902, "This network is not saved in the wallet");
  if (saved?.networkId === network.id) return { result: null };
  await chromeSet("local", STORAGE_KEYS.settings, {
    ...(saved ?? {}),
    networkId: network.id,
    customNetworks: custom,
  });
  void listConnections().then((connections) => broadcast(
    "chainChanged",
    networkHex(network.chainId),
    connections.map((entry) => entry.origin),
  ));
  return { result: null };
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

function isWalletUiSender(sender: chrome.runtime.MessageSender): boolean {
  if (sender.id !== chrome.runtime.id || sender.tab !== undefined || !sender.url) return false;
  try {
    const url = new URL(sender.url);
    return url.protocol === "chrome-extension:" && url.hostname === chrome.runtime.id;
  } catch {
    return false;
  }
}
/** Provider events reach the page through the content script in every tab. */
async function broadcast(name: string, data: unknown, origins?: readonly string[]): Promise<void> {
  const tabs = await chrome.tabs.query({});
  await Promise.all(tabs.map(async (tab) => {
    if (tab.id === undefined) return;
    try {
      await chrome.tabs.sendMessage(tab.id, { kind: "provider-event", name, data, origins });
    } catch {
      // No content script in that tab; nothing to tell.
    }
  }));
}

async function handle(call: RpcCall, origin: string, title?: string): Promise<Answer> {
  const method = call.method;
  const params = call.params ?? [];
  const network = await activeNetwork();

  if (method === "eth_chainId") return { result: networkHex(network.chainId) };
  if (method === "net_version") return { result: String(network.chainId) };
  // Public chain data needs no permission — but it does need to be on the list.
  if (READ_METHODS.has(method)) return forward(call, network);

  if (method === "eth_accounts") return { result: await connectedAccounts(origin) };
  if (method === "wallet_getPermissions") {
    const granted = await connectedAccounts(origin);
    return { result: granted.length > 0 ? [{ parentCapability: "eth_accounts" }] : [] };
  }

  if (method === "eth_requestAccounts" || method === "wallet_requestPermissions") {
    const permission = [{ parentCapability: "eth_accounts" }];
    const granted = await connectedAccounts(origin);
    if (granted.length > 0) {
      return { result: method === "eth_requestAccounts" ? granted : permission };
    }
    const account = await activeAccount();
    if (!account) return fail(4100, "No wallet set up in the extension");
    const answer = await askUser({ kind: "connect", origin, title, account, networkId: network.id });
    if (answer.error) return answer;
    const approved = String(answer.result);
    await grantConnection(origin, [approved as `0x${string}`]);
    void broadcast("accountsChanged", [approved], [origin]);
    return { result: method === "eth_requestAccounts" ? [approved] : permission };
  }
  if (method === "wallet_revokePermissions") {
    await revokeConnection(origin);
    void broadcast("accountsChanged", [], [origin]);
    return { result: null };
  }
  if (method === "wallet_watchAsset") return { result: false };

  const granted = await connectedAccounts(origin);
  const account = granted[0];
  if (!account) return fail(4100, "This site is not connected to the wallet");

  if (method === "wallet_switchEthereumChain" || method === "wallet_addEthereumChain") {
    const requested = chainRequested(params);
    if (!requested) return fail(-32602, "A chainId is required");
    const target = await savedNetworkForChain(requested);
    if (!target) return fail(4902, "This network is not saved in the wallet");
    if (target.id === network.id) return { result: null };
    const answer = await askUser({
      kind: "switch-network",
      origin,
      title,
      account,
      networkId: network.id,
      targetNetworkId: target.id,
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
    return askUser({
      kind: "transaction",
      origin,
      title,
      account,
      networkId: network.id,
      tx: {
        to: raw.to as `0x${string}` | undefined,
        value: raw.value,
        data: raw.data as `0x${string}` | undefined,
        gas: raw.gas,
      },
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
    return askUser({ kind: "sign", origin, title, account, message, networkId: network.id });
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
    return askUser({ kind: "sign-typed", origin, title, account, message, networkId: network.id });
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
    | { kind?: string; call?: RpcCall; name?: string; data?: unknown; origins?: readonly string[] }
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
    const release = providerIngress.tryAcquire(origin);
    if (!release) {
      sendResponse(fail(-32005, "The wallet request queue is busy"));
      return false;
    }
    void handle(request.call, origin, sender.tab?.title)
      .catch((error: unknown) => fail(-32603, error instanceof Error ? error.message : "Wallet request failed"))
      .then(sendResponse)
      .finally(release);
    return true;
  }

  // The wallet UI asks the worker to fan an event out to connected pages.
  if (
    request?.kind === "wallet-event"
    && typeof request.name === "string"
    && PROVIDER_EVENTS.has(request.name)
    && isWalletUiSender(sender)
    && (
      request.origins === undefined
      || (
        Array.isArray(request.origins)
        && request.origins.length <= 128
        && request.origins.every((origin) =>
          typeof origin === "string" && origin.length <= 2_048 && /^https?:\/\//u.test(origin)
        )
      )
    )
  ) {
    void (request.origins
      ? broadcast(request.name, request.data, request.origins)
      : listConnections().then((connections) => broadcast(
        request.name!,
        request.data,
        connections.map((entry) => entry.origin),
      )))
      .then(() => sendResponse({ result: null }))
      .catch((error: unknown) => sendResponse(fail(-32603, error instanceof Error ? error.message : "Event failed")));
    return true;
  }

  return false;
});

// A queue left behind by a previous worker life still needs its window. Claim
// expired rows under the queue lock first so a newly arriving request cannot be
// mistaken for stale bootstrap state.
void takeExpiredPending().then(async (expired) => {
  await Promise.allSettled(expired.map((request) => rejectRequest(request.id, "Request expired")));
  const first = (await listPending())[0];
  if (!first) {
    await syncKeepAlive();
    return;
  }
  await keepAlive().catch(() => undefined);
  await openApproval(first.id);
}).catch(() => undefined);
