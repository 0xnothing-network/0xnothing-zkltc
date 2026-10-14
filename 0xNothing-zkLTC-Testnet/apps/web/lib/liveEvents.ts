import type { Address, Hex } from "viem";
import type { QueryKey } from "@tanstack/react-query";
import testnet from "@fi/config/testnet.generated.json";
import { PIXEL_CLASSIC_ADDRESS, PIXEL_NFT_ADDRESS } from "./publicConfig";

/** keccak256("Transfer(address,address,uint256)"): ERC-20 and ERC-721 share it. */
export const TRANSFER_TOPIC: Hex = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const MAX_WATCHED_ADDRESSES = 256;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
const KEEP_ALIVE_MS = 25_000;
const REQUEST_TIMEOUT_MS = 10_000;

function collectAddresses(value: unknown, into: Set<string>): void {
  if (typeof value === "string") {
    if (ADDRESS.test(value)) into.add(value.toLowerCase());
  } else if (value && typeof value === "object") {
    for (const entry of Object.values(value)) collectAddresses(entry, into);
  }
}

/** Every protocol contract of the active deployment; their events also drive indexer-backed views. */
export const STATIC_LIVE_ADDRESSES: readonly string[] = (() => {
  const addresses = new Set<string>();
  collectAddresses(testnet, addresses);
  addresses.add(PIXEL_CLASSIC_ADDRESS.toLowerCase());
  addresses.add(PIXEL_NFT_ADDRESS.toLowerCase());
  return [...addresses].sort();
})();

function contractAddress(value: unknown): string | undefined {
  const address = value && typeof value === "object" ? (value as { address?: unknown }).address : undefined;
  return typeof address === "string" && ADDRESS.test(address) ? address.toLowerCase() : undefined;
}

/** Contracts a wagmi read query is reading; account addresses in balance keys are not contracts. */
export function contractAddressesInQueryKey(queryKey: QueryKey): string[] {
  if (queryKey[0] === "readContract") {
    const address = contractAddress(queryKey[1]);
    return address ? [address] : [];
  }
  if (queryKey[0] === "readContracts") {
    const contracts = (queryKey[1] as { contracts?: unknown } | undefined)?.contracts;
    if (!Array.isArray(contracts)) return [];
    return contracts.flatMap((contract) => {
      const address = contractAddress(contract);
      return address ? [address] : [];
    });
  }
  return [];
}

/**
 * The log filter: protocol contracts first, then whatever the mounted views read
 * (pump tokens, user-created pairs), bounded so one page cannot grow the filter
 * without limit. Sorted so an unchanged set compares equal.
 */
export function liveWatchAddresses(queryKeys: Iterable<QueryKey>): string[] {
  const addresses = new Set(STATIC_LIVE_ADDRESSES);
  for (const queryKey of queryKeys) {
    for (const address of contractAddressesInQueryKey(queryKey)) {
      if (addresses.size >= MAX_WATCHED_ADDRESSES) break;
      addresses.add(address);
    }
  }
  return [...addresses].sort();
}

export function addressTopic(account: Address): Hex {
  return `0x${account.slice(2).toLowerCase().padStart(64, "0")}`;
}

export type Timers = {
  setTimeout: (callback: () => void, ms: number) => unknown;
  clearTimeout: (id: unknown) => void;
  setInterval: (callback: () => void, ms: number) => unknown;
  clearInterval: (id: unknown) => void;
  now: () => number;
};

const defaultTimers: Timers = {
  setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms),
  clearTimeout: (id) => globalThis.clearTimeout(id as ReturnType<typeof setTimeout>),
  setInterval: (callback, ms) => globalThis.setInterval(callback, ms),
  clearInterval: (id) => globalThis.clearInterval(id as ReturnType<typeof setInterval>),
  now: () => Date.now(),
};

/**
 * Turns bursts of chain events into refresh waves: the first event refreshes at
 * once, later ones at most every `minGapMs`, and one follow-up runs `followUpMs`
 * after the last event, once indexers and the short server caches have caught up.
 */
export function createWaveScheduler(
  run: () => void,
  { minGapMs, followUpMs }: { minGapMs: number; followUpMs: number },
  timers: Timers = defaultTimers,
) {
  let lastRun = Number.NEGATIVE_INFINITY;
  let throttled: unknown;
  let followUp: unknown;
  let disposed = false;

  const fire = () => {
    if (disposed) return;
    lastRun = timers.now();
    run();
  };

  return {
    trigger() {
      if (disposed) return;
      const wait = lastRun + minGapMs - timers.now();
      if (wait <= 0) fire();
      else if (throttled === undefined) {
        throttled = timers.setTimeout(() => { throttled = undefined; fire(); }, wait);
      }
      if (followUp !== undefined) timers.clearTimeout(followUp);
      followUp = timers.setTimeout(() => { followUp = undefined; fire(); }, followUpMs);
    },
    dispose() {
      disposed = true;
      if (throttled !== undefined) timers.clearTimeout(throttled);
      if (followUp !== undefined) timers.clearTimeout(followUp);
    },
  };
}

type Subscription = { unsubscribe: () => Promise<unknown> };
type LogFilter = { address?: string[]; topics?: (Hex | null)[] };

export type LiveTransport = {
  subscribe(args: {
    params: ["logs", LogFilter];
    onData: (data: unknown) => void;
    onError: (error: unknown) => void;
  }): Promise<Subscription>;
  close(): void;
};

export type SocketLike = {
  send(data: string): void;
  close(): void;
  addEventListener(type: "open" | "close" | "error" | "message", listener: (event: { data?: unknown }) => void): void;
};

type RpcMessage = {
  id?: unknown;
  method?: unknown;
  params?: { subscription?: unknown; result?: unknown };
  result?: unknown;
  error?: { message?: unknown };
};

/**
 * Minimal JSON-RPC client over one WebSocket, owned by a single session: no
 * shared socket cache and no reconnect of its own. A cheap request every 25 s
 * keeps proxies from idling the connection out and exposes a dead one. Any
 * close, error or timeout fails every subscription once; `close()` is silent.
 */
export function openLiveTransport(
  url: string,
  createSocket: (url: string) => SocketLike = (target) => new WebSocket(target),
  timers: Timers = defaultTimers,
): LiveTransport {
  const socket = createSocket(url);
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: unknown }>();
  const subscriptions = new Map<string, { onData: (data: unknown) => void; onError: (error: unknown) => void }>();
  let nextId = 1;
  let finished = false;
  let opened = false;
  const waitingForOpen: Array<{ resolve: () => void; reject: (error: Error) => void }> = [];

  const finish = (error: Error | undefined) => {
    if (finished) return;
    finished = true;
    timers.clearInterval(keepAlive);
    const closedError = error ?? new Error("Live socket closed");
    for (const waiter of waitingForOpen.splice(0)) waiter.reject(closedError);
    for (const entry of pending.values()) {
      timers.clearTimeout(entry.timer);
      entry.reject(closedError);
    }
    pending.clear();
    const handlers = [...subscriptions.values()];
    subscriptions.clear();
    if (error) for (const handler of handlers) handler.onError(error);
    try {
      socket.close();
    } catch {
      // Already closed.
    }
  };

  socket.addEventListener("open", () => {
    opened = true;
    for (const waiter of waitingForOpen.splice(0)) waiter.resolve();
  });
  socket.addEventListener("close", () => finish(new Error("Live socket closed")));
  socket.addEventListener("error", () => finish(new Error("Live socket failed")));
  socket.addEventListener("message", (event) => {
    let message: RpcMessage;
    try {
      message = JSON.parse(String(event.data)) as RpcMessage;
    } catch {
      return;
    }
    if (message.method === "eth_subscription") {
      const id = message.params?.subscription;
      if (typeof id === "string") subscriptions.get(id)?.onData(message.params?.result);
      return;
    }
    if (typeof message.id !== "number") return;
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    timers.clearTimeout(entry.timer);
    if (message.error) {
      entry.reject(new Error(typeof message.error.message === "string" ? message.error.message : "Live socket request failed"));
    } else {
      entry.resolve(message.result);
    }
  });

  const whenOpen = () => opened
    ? Promise.resolve()
    : new Promise<void>((resolve, reject) => {
      if (finished) reject(new Error("Live socket closed"));
      else waitingForOpen.push({ resolve, reject });
    });

  const request = async (method: string, params: unknown[]): Promise<unknown> => {
    await whenOpen();
    if (finished) throw new Error("Live socket closed");
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = timers.setTimeout(() => {
        pending.delete(id);
        reject(new Error("Live socket request timed out"));
        finish(new Error("Live socket stopped responding"));
      }, REQUEST_TIMEOUT_MS);
      pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    });
  };

  const keepAlive = timers.setInterval(() => {
    void request("net_version", []).catch(() => undefined);
  }, KEEP_ALIVE_MS);

  return {
    async subscribe({ params, onData, onError }) {
      const id = await request("eth_subscribe", params);
      if (typeof id !== "string") throw new Error("Invalid subscription id");
      subscriptions.set(id, { onData, onError });
      return {
        async unsubscribe() {
          if (!subscriptions.delete(id) || finished) return;
          await request("eth_unsubscribe", [id]).catch(() => undefined);
        },
      };
    },
    close: () => finish(undefined),
  };
}

export type LiveSocketSession = {
  setAddresses(addresses: readonly string[]): void;
  setAccount(account: Address | undefined): void;
  /** Reconnect now (tab shown again, network back) instead of waiting for the backoff. */
  wake(): void;
  dispose(): void;
};

/**
 * One log subscription for the watched contracts and two for Transfer events to
 * and from the connected account (tokens of any contract, NFTs included). Any
 * event, and every successful reconnect, calls `onEvent`; the first connect does
 * not, since the views have just loaded. A dropped socket is retried with
 * exponential backoff, alternating across `urls`.
 */
export function startLiveSocket({
  urls,
  onEvent,
  onStatus,
  open = (url) => openLiveTransport(url),
  timers = defaultTimers,
}: {
  urls: readonly string[];
  onEvent: () => void;
  onStatus: (connected: boolean) => void;
  open?: (url: string) => LiveTransport;
  timers?: Timers;
}): LiveSocketSession {
  let addresses: readonly string[] = STATIC_LIVE_ADDRESSES;
  let account: Address | undefined;
  let subscribedAddresses: readonly string[] | undefined;
  let subscribedAccount: Address | undefined;
  let transport: LiveTransport | undefined;
  let contractSubscription: Subscription | undefined;
  let accountSubscriptions: Subscription[] = [];
  let attempt = 0;
  let reconnectTimer: unknown;
  let generation = 0;
  let connected = false;
  let everConnected = false;
  let disposed = false;

  const setConnected = (value: boolean) => {
    if (connected === value) return;
    connected = value;
    onStatus(value);
  };

  const release = (subscriptions: Array<Subscription | undefined>) => {
    for (const subscription of subscriptions) void subscription?.unsubscribe().catch(() => undefined);
  };

  const teardown = () => {
    generation += 1;
    const closing = transport;
    transport = undefined;
    contractSubscription = undefined;
    accountSubscriptions = [];
    subscribedAddresses = undefined;
    subscribedAccount = undefined;
    closing?.close();
  };

  const fail = (failedGeneration: number) => {
    if (disposed || failedGeneration !== generation) return;
    teardown();
    setConnected(false);
    const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** attempt);
    attempt += 1;
    if (reconnectTimer !== undefined) timers.clearTimeout(reconnectTimer);
    reconnectTimer = timers.setTimeout(() => {
      reconnectTimer = undefined;
      void connect();
    }, delay);
  };

  const subscribeContracts = (current: LiveTransport, currentGeneration: number) => {
    subscribedAddresses = addresses;
    if (addresses.length === 0) return Promise.resolve(undefined);
    return current.subscribe({
      params: ["logs", { address: [...addresses] }],
      onData: onEvent,
      onError: () => fail(currentGeneration),
    });
  };

  const subscribeAccount = (current: LiveTransport, currentGeneration: number) => {
    subscribedAccount = account;
    if (!account) return Promise.resolve([] as Subscription[]);
    const topic = addressTopic(account);
    return Promise.all([
      current.subscribe({ params: ["logs", { topics: [TRANSFER_TOPIC, topic] }], onData: onEvent, onError: () => fail(currentGeneration) }),
      current.subscribe({ params: ["logs", { topics: [TRANSFER_TOPIC, null, topic] }], onData: onEvent, onError: () => fail(currentGeneration) }),
    ]);
  };

  async function resubscribe(kind: "contracts" | "account"): Promise<void> {
    const current = transport;
    if (!current || !connected) return;
    const currentGeneration = generation;
    try {
      if (kind === "contracts") {
        const previous = contractSubscription;
        const next = await subscribeContracts(current, currentGeneration);
        if (currentGeneration !== generation) return release([next]);
        contractSubscription = next;
        release([previous]);
      } else {
        const previous = accountSubscriptions;
        const next = await subscribeAccount(current, currentGeneration);
        if (currentGeneration !== generation) return release(next);
        accountSubscriptions = next;
        release(previous);
      }
    } catch {
      fail(currentGeneration);
    }
  }

  async function connect(): Promise<void> {
    if (disposed || transport) return;
    const currentGeneration = ++generation;
    const url = urls[attempt % urls.length];
    if (!url) return;
    let current: LiveTransport;
    try {
      current = open(url);
    } catch {
      return fail(currentGeneration);
    }
    transport = current;
    try {
      const [contracts, accountSubs] = await Promise.all([
        subscribeContracts(current, currentGeneration),
        subscribeAccount(current, currentGeneration),
      ]);
      if (disposed || currentGeneration !== generation) {
        release([contracts, ...accountSubs]);
        return;
      }
      contractSubscription = contracts;
      accountSubscriptions = accountSubs;
      attempt = 0;
      setConnected(true);
      // Events emitted while the socket was down are not replayed; refresh once instead.
      if (everConnected) onEvent();
      everConnected = true;
      // The filter may have changed while subscribing.
      if (subscribedAddresses !== addresses) void resubscribe("contracts");
      if (subscribedAccount !== account) void resubscribe("account");
    } catch {
      fail(currentGeneration);
    }
  }

  void connect();

  return {
    setAddresses(next) {
      if (next.length === addresses.length && next.every((address, index) => address === addresses[index])) return;
      addresses = [...next];
      void resubscribe("contracts");
    },
    setAccount(next) {
      const normalized = next?.toLowerCase() as Address | undefined;
      if (normalized === account) return;
      account = normalized;
      void resubscribe("account");
    },
    wake() {
      if (disposed || transport) return;
      if (reconnectTimer !== undefined) timers.clearTimeout(reconnectTimer);
      reconnectTimer = undefined;
      attempt = 0;
      void connect();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (reconnectTimer !== undefined) timers.clearTimeout(reconnectTimer);
      release([contractSubscription, ...accountSubscriptions]);
      teardown();
      setConnected(false);
    },
  };
}
