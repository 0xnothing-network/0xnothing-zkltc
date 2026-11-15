import { type ContentMessage, isPageMessage, TO_PAGE, WALLET_STOPPED_MESSAGE } from "./protocol";

/**
 * The relay, in the ISOLATED world: it can reach both `window` and
 * `chrome.runtime`, which is exactly what the page and the service worker cannot
 * do for each other. It carries messages and nothing else — no keys, no state,
 * no decisions. The origin the worker uses for permissions is taken from this
 * frame, never from the message body, so a page cannot claim to be another site.
 */
function reply(message: ContentMessage): void {
  // "/" is the same-origin target: identical in effect to the frame's own origin,
  // but it also holds in a sandboxed frame, where `location.origin` is the string
  // "null" and postMessage would throw — taking the reply, and the page's pending
  // request, down with it.
  window.postMessage(message, "/");
}

// Set once this frame's page has used the provider (the top frame does at load).
// Only such frames pull their state after a ping: a frame that never asked has
// nothing to update, and every ad frame of every tab would wake the worker.
let used = false;
// Pulls are numbered so an older answer arriving late cannot undo a newer one.
let pulls = 0;

window.addEventListener("message", (event: MessageEvent) => {
  if (event.source !== window) return;
  const message = event.data;
  if (!isPageMessage(message)) return;
  used = true;

  // An orphaned script (the extension was reloaded) can throw here instead of
  // rejecting; both take the same 4900 path below.
  new Promise<{ result?: unknown; error?: { code: number; message: string } }>((resolve) => {
    resolve(chrome.runtime.sendMessage({ kind: "provider-request", call: message.call }));
  })
    .then((response: { result?: unknown; error?: { code: number; message: string } }) => {
      reply({
        channel: TO_PAGE,
        id: message.id,
        result: response?.result,
        error: response?.error,
      });
    })
    .catch(() => {
      // The worker was replaced or the extension was reloaded mid-flight. The
      // code stays 4900 so the dapp may retry; Chrome's text is not passed on.
      reply({
        channel: TO_PAGE,
        id: message.id,
        error: { code: 4900, message: WALLET_STOPPED_MESSAGE },
      });
    });
});

// The worker pings every frame when the account or chain changes; the ping says
// nothing else. This frame then asks for its own state, which the worker answers
// for the origin the browser reports, and the page provider emits what changed.
chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  const event = message as { kind?: string; name?: string } | null;
  // The worker asks whether this document is still the one its requests came from
  // (the tab reported a load); answering at all is the whole reply.
  if (event?.kind === "provider-alive") {
    sendResponse(true);
    return;
  }
  if (event?.kind !== "provider-event" || typeof event.name !== "string") return;
  // A sandboxed frame's real origin is opaque ("null"): the worker refuses it, so it
  // does not ask.
  if (self.origin === "null" || !used) return;
  const pull = ++pulls;
  chrome.runtime
    .sendMessage({ kind: "provider-state" })
    .then((response: { result?: ContentMessage["state"] } | undefined) => {
      if (pull !== pulls || response?.result === undefined) return;
      reply({ channel: TO_PAGE, state: response.result });
    })
    .catch(() => {
      // The worker is waking or was replaced; the page re-reads on its next call.
    });
});
