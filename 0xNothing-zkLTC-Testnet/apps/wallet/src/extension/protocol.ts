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

export function isPageMessage(value: unknown): value is PageMessage {
  const message = value as PageMessage | null;
  return !!message && message.channel === TO_CONTENT && typeof message.id === "string"
    && typeof message.call?.method === "string";
}

export function isContentMessage(value: unknown): value is ContentMessage {
  return !!value && (value as ContentMessage).channel === TO_PAGE;
}
