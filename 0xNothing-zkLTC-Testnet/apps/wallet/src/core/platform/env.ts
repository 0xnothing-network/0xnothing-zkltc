/**
 * Runtime detection. One bundle runs in three places:
 *
 *  - MV3 popup / approval window  (chrome-extension://)
 *  - Capacitor Android WebView    (https://localhost)
 *  - `vite dev` in a normal tab   (development only)
 *
 * Capacitor is detected off the injected `window.Capacitor` global rather than
 * by importing @capacitor/core, so the extension bundle stays free of the
 * native runtime.
 */

export type Platform = "extension" | "android" | "web";

interface CapacitorGlobal {
  isNativePlatform?: () => boolean;
  getPlatform?: () => string;
}

function capacitorGlobal(): CapacitorGlobal | undefined {
  return (globalThis as { Capacitor?: CapacitorGlobal }).Capacitor;
}

export const hasChromeStorage: boolean =
  typeof chrome !== "undefined" && !!chrome?.storage?.local && !!chrome?.runtime?.id;

export const isAndroid: boolean = (() => {
  const cap = capacitorGlobal();
  if (!cap?.isNativePlatform?.()) return false;
  return (cap.getPlatform?.() ?? "android") !== "web";
})();

export const platform: Platform = hasChromeStorage ? "extension" : isAndroid ? "android" : "web";

export const isExtension = platform === "extension";

/**
 * Which extension page this is. The same index.html is the popup, the approval
 * window (`#/approve…`), Chrome's side panel (the manifest opens it with
 * `?surface=panel`) and a full tab (`?surface=tab`). Anything else is the popup,
 * which is also what an index.html opened by hand has always been.
 */
export type ExtensionView = "popup" | "panel" | "tab" | "approval";

export function extensionViewFor(search: string, hash: string): ExtensionView {
  if (hash.startsWith("#/approve")) return "approval";
  const surface = new URLSearchParams(search).get("surface");
  if (surface === "panel") return "panel";
  if (surface === "tab") return "tab";
  return "popup";
}

/** The extension page this is, or null off the extension (Android, `vite dev`). */
export function extensionView(): ExtensionView | null {
  if (!isExtension) return null;
  return extensionViewFor(window.location.search, window.location.hash);
}

/**
 * The popup is a fixed 360×600 surface; the approval window, the side panel, a
 * wallet tab and Android get the full viewport. Used to pick the root size
 * class, never to change behaviour.
 */
export function isPopupSurface(): boolean {
  return extensionView() === "popup";
}

/**
 * Chrome's side panel can take the wallet from the popup only: the popup is where
 * the user's click is, and a panel or a tab opening another panel helps no one.
 * Chromium builds without the API (and Android) never see the control.
 */
export function canOpenSidePanel(): boolean {
  return extensionView() === "popup" && typeof chrome.sidePanel?.open === "function";
}

/**
 * sidePanel.open() is honoured only inside a user gesture, so the caller passes a
 * window id it read beforehand and calls this straight from the click, with
 * nothing awaited first.
 */
export function openSidePanel(windowId: number): Promise<void> {
  return chrome.sidePanel.open({ windowId });
}

/** A full tab is offered from the popup and the panel; a wallet tab is already one. */
export function canOpenWalletTab(): boolean {
  const view = extensionView();
  return (view === "popup" || view === "panel") && typeof chrome.tabs?.create === "function";
}

export async function openWalletTab(): Promise<void> {
  await chrome.tabs.create({ url: chrome.runtime.getURL("index.html?surface=tab") });
}

/** Opens a page outside the wallet surface, on whichever platform we are on. */
export async function openExternal(url: string): Promise<void> {
  if (isExtension && chrome?.tabs?.create) {
    await chrome.tabs.create({ url });
    return;
  }
  if (isAndroid) {
    try {
      const { Browser } = await import("@capacitor/browser");
      await Browser.open({ url, presentationStyle: "popover" });
      return;
    } catch {
      // fall through to window.open
    }
  }
  window.open(url, "_blank", "noopener,noreferrer");
}

/** Best-effort clipboard write that works on all three surfaces. */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // permission denied or unfocused document — try the platform plugin
  }
  if (isAndroid) {
    try {
      const { Clipboard } = await import("@capacitor/clipboard");
      await Clipboard.write({ string: text });
      return true;
    } catch {
      // fall through
    }
  }
  try {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(area);
    return ok;
  } catch {
    return false;
  }
}
