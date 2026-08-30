import { targetsOrigin, type ContentMessage, isPageMessage, TO_PAGE } from "./protocol";

/**
 * The relay, in the ISOLATED world: it can reach both `window` and
 * `chrome.runtime`, which is exactly what the page and the service worker cannot
 * do for each other. It carries messages and nothing else — no keys, no state,
 * no decisions. The origin the worker uses for permissions is taken from this
 * frame, never from the message body, so a page cannot claim to be another site.
 */
function reply(message: ContentMessage): void {
  window.postMessage(message, window.location.origin);
}

window.addEventListener("message", (event: MessageEvent) => {
  if (event.source !== window) return;
  const message = event.data;
  if (!isPageMessage(message)) return;

  chrome.runtime
    .sendMessage({ kind: "provider-request", call: message.call })
    .then((response: { result?: unknown; error?: { code: number; message: string } }) => {
      reply({
        channel: TO_PAGE,
        id: message.id,
        result: response?.result,
        error: response?.error,
      });
    })
    .catch((error: unknown) => {
      // The worker was replaced or the extension was reloaded mid-flight.
      reply({
        channel: TO_PAGE,
        id: message.id,
        error: {
          code: 4900,
          message: error instanceof Error ? error.message : "Wallet is disconnected",
        },
      });
    });
});

// Account and chain changes are pushed by the worker to every connected frame.
chrome.runtime.onMessage.addListener((message: unknown) => {
  const event = message as { kind?: string; name?: string; data?: unknown; origins?: readonly string[] } | null;
  if (event?.kind !== "provider-event" || typeof event.name !== "string") return;
  if (!targetsOrigin(event.origins, window.location.origin)) return;
  reply({ channel: TO_PAGE, event: { name: event.name, data: event.data } });
});
