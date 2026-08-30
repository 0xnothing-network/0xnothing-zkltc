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
 * The popup is a fixed 360×600 surface; the approval window and Android get the
 * full viewport. Used to pick the root size class, never to change behaviour.
 */
export function isPopupSurface(): boolean {
  if (!isExtension) return false;
  return !window.location.hash.startsWith("#/approve");
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
