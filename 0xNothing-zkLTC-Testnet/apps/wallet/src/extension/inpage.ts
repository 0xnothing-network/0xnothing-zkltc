import {
  isContentMessage,
  PROVIDER_CHAIN_ID_HEX,
  PROVIDER_ICON,
  PROVIDER_NAME,
  PROVIDER_RDNS,
  newProviderUuid,
  type RpcCall,
  type RpcFailure,
  TO_CONTENT,
} from "./protocol";

/**
 * The provider a page sees. Runs in the MAIN world at document_start, holds no
 * secrets and talks to nothing but the content script: every request is relayed,
 * approved and signed elsewhere. Announced over EIP-6963 and, only when no other
 * wallet has claimed it, also installed as `window.ethereum`.
 */
class ProviderRpcError extends Error {
  readonly code: number;

  constructor(failure: RpcFailure) {
    super(failure.message);
    this.name = "ProviderRpcError";
    this.code = failure.code;
  }
}

type Listener = (...args: unknown[]) => void;

interface Waiting {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  timer: number;
}

const PROVIDER_REQUEST_TIMEOUT_MS = 250_000;
const waiting = new Map<string, Waiting>();
const listeners = new Map<string, Set<Listener>>();
let requestCounter = 0;

function emit(name: string, data: unknown): void {
  for (const listener of listeners.get(name) ?? []) {
    try {
      listener(data);
    } catch {
      // A dapp's own handler throwing must not break the provider.
    }
  }
}

function nextId(): string {
  requestCounter += 1;
  return `${Date.now().toString(36)}-${requestCounter}`;
}

function send(call: RpcCall): Promise<unknown> {
  const id = nextId();
  return new Promise<unknown>((resolve, reject) => {
    const timer = window.setTimeout(() => {
      if (!waiting.delete(id)) return;
      reject(new ProviderRpcError({ code: 4900, message: "Wallet request timed out" }));
    }, PROVIDER_REQUEST_TIMEOUT_MS);
    waiting.set(id, { resolve, reject, timer });
    try {
      window.postMessage({ channel: TO_CONTENT, id, call }, window.location.origin);
    } catch (error) {
      window.clearTimeout(timer);
      waiting.delete(id);
      reject(error);
    }
  });
}

let chainId: string = PROVIDER_CHAIN_ID_HEX;
let accounts: string[] = [];

window.addEventListener("message", (event: MessageEvent) => {
  // Only same-window messages from our own content script are answers.
  if (event.source !== window) return;
  const message = event.data;
  if (!isContentMessage(message)) return;
  if (message.event) {
    if (message.event.name === "chainChanged") chainId = message.event.data as string;
    if (message.event.name === "accountsChanged") accounts = message.event.data as string[];
    emit(message.event.name, message.event.data);
    return;
  }
  if (!message.id) return;
  const pending = waiting.get(message.id);
  if (!pending) return;
  waiting.delete(message.id);
  window.clearTimeout(pending.timer);
  if (message.error) {
    pending.reject(new ProviderRpcError(message.error));
    return;
  }
  pending.resolve(message.result);
});

class NothingProvider {
  readonly isNothingWallet = true;

  get chainId(): string {
    return chainId;
  }

  get selectedAddress(): string | null {
    return accounts[0] ?? null;
  }

  isConnected(): boolean {
    return true;
  }

  async request(args: RpcCall): Promise<unknown> {
    if (!args || typeof args.method !== "string") {
      throw new ProviderRpcError({ code: -32600, message: "Invalid request" });
    }
    const result = await send({ method: args.method, params: args.params ?? [] });
    if (args.method === "eth_requestAccounts" || args.method === "eth_accounts") {
      accounts = (result as string[] | null) ?? [];
    }
    return result;
  }

  on(name: string, listener: Listener): this {
    const set = listeners.get(name) ?? new Set<Listener>();
    set.add(listener);
    listeners.set(name, set);
    return this;
  }

  removeListener(name: string, listener: Listener): this {
    const set = listeners.get(name);
    if (!set) return this;
    set.delete(listener);
    if (set.size === 0) listeners.delete(name);
    return this;
  }

  /** Pre-EIP-1193 shims: enough for dapps that still call the old shapes. */
  async enable(): Promise<unknown> {
    return this.request({ method: "eth_requestAccounts" });
  }

  async send(method: string, params?: unknown[]): Promise<unknown> {
    return this.request({ method, params });
  }
}

const provider = new NothingProvider();
const providerUuid = newProviderUuid();
const providerInfo = Object.freeze({
  uuid: providerUuid,
  name: PROVIDER_NAME,
  icon: PROVIDER_ICON,
  rdns: PROVIDER_RDNS,
});
const providerDetail = Object.freeze({
  info: providerInfo,
  provider,
});

function announce(): void {
  window.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail: providerDetail }));
}

window.addEventListener("eip6963:requestProvider", announce);
announce();

// Own namespace always; the shared one only when no other wallet claimed it, so
// installing this extension cannot break a page's existing provider.
Object.defineProperty(window, "zeroxnothing", {
  configurable: false,
  enumerable: false,
  get: () => provider,
});

if (!(window as { ethereum?: unknown }).ethereum) {
  try {
    Object.defineProperty(window, "ethereum", {
      configurable: true,
      enumerable: true,
      writable: true,
      value: provider,
    });
  } catch {
    (window as { ethereum?: unknown }).ethereum = provider;
  }
}

// Tell the page which account and chain it already has, if any. The chain is
// requested instead of assuming the built-in value so a saved custom network
// is reflected even before the first dapp request.
void Promise.all([
  provider.request({ method: "eth_chainId" }),
  provider.request({ method: "eth_accounts" }),
])
  .then(([nextChainId, result]) => {
    if (typeof nextChainId === "string" && /^0x[0-9a-f]+$/i.test(nextChainId)) {
      chainId = nextChainId;
    }
    accounts = (result as string[] | null) ?? [];
    if (accounts.length > 0) emit("connect", { chainId });
  })
  .catch(() => {
    // Not connected or the worker is waking: the page will ask when needed.
  });
