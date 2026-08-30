/**
 * The wire between page, content script and service worker.
 *
 * Deliberately dependency-free: `inpage.ts` runs in the page's MAIN world and
 * must stay a few kilobytes of plain JavaScript, so nothing here may import
 * viem, React or anything that would drag a bundle into every tab.
 */

/** page → content script */
export const TO_CONTENT = "0xnothing:to-content";
/** content script → page */
export const TO_PAGE = "0xnothing:to-page";

/**
 * Hex chain id for `eth_chainId`. Duplicated from config/chain.ts on purpose —
 * see the note above — and pinned by tests/protocol.test.ts so the two literals
 * cannot drift apart.
 */
export const PROVIDER_CHAIN_ID_HEX = "0x1159";

export const PROVIDER_RDNS = "xyz.zeroxnothing.wallet";
export const PROVIDER_NAME = "0xNothing Wallet";

export const MAX_PROVIDER_ID_LENGTH = 128;
export const MAX_PROVIDER_METHOD_LENGTH = 128;
export const MAX_PROVIDER_CALL_BYTES = 4 * 1024 * 1024;
const MAX_PROVIDER_JSON_DEPTH = 64;
const MAX_PROVIDER_JSON_NODES = 50_000;

/** EIP-6963 provider UUID: stable for this page load, without requiring a
 * secure context (the injector can also run on plain http:// pages). */
export function newProviderUuid(): string {
  const bytes = new Uint8Array(16);
  try {
    crypto.getRandomValues(bytes);
  } catch {
    const seed = `${Date.now()}-${Math.random()}`;
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = seed.charCodeAt(index % seed.length) & 0xff;
    }
  }
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function targetsOrigin(origins: readonly string[] | undefined, origin: string): boolean {
  return origins === undefined || origins.includes(origin);
}

/** The brand mark as an inline SVG: EIP-6963 requires a data URI icon. */
export const PROVIDER_ICON =
  "data:image/svg+xml;utf8,%3Csvg%20xmlns%3D'http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg'%20"
  + "viewBox%3D'0%200%2064%2064'%3E%3Ccircle%20cx%3D'32'%20cy%3D'32'%20r%3D'32'%20fill%3D'%23050806'"
  + "%2F%3E%3Ctext%20x%3D'32'%20y%3D'45'%20font-family%3D'monospace'%20font-size%3D'40'%20"
  + "font-weight%3D'700'%20text-anchor%3D'middle'%20fill%3D'%23edf5f0'%3EN%3C%2Ftext%3E%3Ccircle"
  + "%20cx%3D'52'%20cy%3D'14'%20r%3D'5'%20fill%3D'%23ff8f9f'%2F%3E%3C%2Fsvg%3E";

export interface RpcCall {
  method: string;
  params?: unknown[];
}

export interface RpcFailure {
  code: number;
  message: string;
}

/** Sent by the page for every provider request. */
export interface PageMessage {
  channel: typeof TO_CONTENT;
  id: string;
  call: RpcCall;
}

/** Sent back to the page: either an answer to `id`, or a provider event. */
export interface ContentMessage {
  channel: typeof TO_PAGE;
  id?: string;
  result?: unknown;
  error?: RpcFailure;
  event?: { name: string; data: unknown; origins?: readonly string[] };
}

function jsonStringBytes(value: string, remaining: number): number | null {
  let bytes = 2; // Surrounding JSON quotes.
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0x22 || code === 0x5c || code === 0x08 || code === 0x09
      || code === 0x0a || code === 0x0c || code === 0x0d) {
      bytes += 2;
    } else if (code < 0x20 || (code >= 0xd800 && code <= 0xdfff)) {
      const next = value.charCodeAt(index + 1);
      if (code >= 0xd800 && code <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else {
        // Well-formed JSON escapes lone UTF-16 surrogates as `\\udxxx`.
        bytes += 6;
      }
    } else if (code < 0x80) {
      bytes += 1;
    } else if (code < 0x800) {
      bytes += 2;
    } else {
      bytes += 3;
    }
    if (bytes > remaining) return null;
  }
  return bytes;
}

/**
 * Measures the JSON wire shape without calling recursive `JSON.stringify`.
 * The page boundary accepts only plain JSON values, caps depth/node count and
 * stops as soon as the byte budget is exhausted, before Chrome clones the call
 * into the extension worker.
 */
function isBoundedJson(value: unknown, maxBytes: number): boolean {
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  const seen = new WeakSet<object>();
  let bytes = 0;
  let nodes = 0;

  const add = (amount: number): boolean => {
    bytes += amount;
    return bytes <= maxBytes;
  };

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || current.depth > MAX_PROVIDER_JSON_DEPTH) return false;
    nodes += 1;
    if (nodes > MAX_PROVIDER_JSON_NODES) return false;

    const item = current.value;
    if (item === null) {
      if (!add(4)) return false;
      continue;
    }
    if (typeof item === "string") {
      const size = jsonStringBytes(item, maxBytes - bytes);
      if (size === null || !add(size)) return false;
      continue;
    }
    if (typeof item === "boolean") {
      if (!add(item ? 4 : 5)) return false;
      continue;
    }
    if (typeof item === "number") {
      if (!Number.isFinite(item) || !add(String(item).length)) return false;
      continue;
    }
    if (typeof item !== "object") return false;
    if (seen.has(item)) return false;
    seen.add(item);

    if (Array.isArray(item)) {
      if (
        item.length > MAX_PROVIDER_JSON_NODES
        || nodes + stack.length + item.length > MAX_PROVIDER_JSON_NODES
        || !add(2 + Math.max(0, item.length - 1))
      ) {
        return false;
      }
      for (let index = item.length - 1; index >= 0; index -= 1) {
        // Sparse and undefined array entries stringify as null, but they are
        // refused here so the worker receives exactly the shape the page sent.
        if (!(index in item)) return false;
        stack.push({ value: item[index], depth: current.depth + 1 });
      }
      continue;
    }

    const prototype = Object.getPrototypeOf(item);
    if (prototype !== Object.prototype && prototype !== null) return false;
    if (!add(2)) return false;
    let properties = 0;
    for (const key in item) {
      if (!Object.prototype.hasOwnProperty.call(item, key)) continue;
      properties += 1;
      if (nodes + stack.length + 1 > MAX_PROVIDER_JSON_NODES) return false;
      const keyBytes = jsonStringBytes(key, maxBytes - bytes);
      if (keyBytes === null || !add(keyBytes + 1 + (properties > 1 ? 1 : 0))) return false;
      stack.push({
        value: (item as Record<string, unknown>)[key],
        depth: current.depth + 1,
      });
    }
  }
  return true;
}

export function isBoundedRpcCall(value: unknown): value is RpcCall {
  try {
    const call = value as RpcCall | null;
    return !!call
      && typeof call.method === "string"
      && call.method.length > 0
      && call.method.length <= MAX_PROVIDER_METHOD_LENGTH
      && (call.params === undefined || Array.isArray(call.params))
      && isBoundedJson(call, MAX_PROVIDER_CALL_BYTES);
  } catch {
    return false;
  }
}

export function isPageMessage(value: unknown): value is PageMessage {
  try {
    const message = value as PageMessage | null;
    return !!message
      && message.channel === TO_CONTENT
      && typeof message.id === "string"
      && message.id.length > 0
      && message.id.length <= MAX_PROVIDER_ID_LENGTH
      && isBoundedRpcCall(message.call);
  } catch {
    return false;
  }
}

export function isContentMessage(value: unknown): value is ContentMessage {
  return !!value && (value as ContentMessage).channel === TO_PAGE;
}
