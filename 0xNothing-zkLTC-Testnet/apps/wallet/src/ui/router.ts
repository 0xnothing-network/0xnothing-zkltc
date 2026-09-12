import { useEffect, useState } from "react";

/**
 * Hash routing, because the popup and the approval window are the same
 * `index.html` opened twice: the worker points the window at
 * `index.html#/approve?id=…` and the popup opens at `#/`. No history API is
 * involved, so nothing here can break when the document is a chrome-extension
 * page or a Capacitor asset.
 */
export type RouteName =
  | "home"
  | "send"
  | "receive"
  | "history"
  | "mint"
  | "earn"
  | "lend"
  | "swap"
  | "dapps"
  | "settings"
  | "quantum"
  | "approve";

export interface Route {
  name: RouteName;
  params: URLSearchParams;
}

const ROUTES = new Set<string>([
  "home",
  "send",
  "receive",
  "history",
  "mint",
  "earn",
  "lend",
  "swap",
  "dapps",
  "settings",
  "quantum",
  "approve",
]);

/**
 * Where the app lands when no route is named. The popup opens at plain
 * `index.html` with no hash, so this is what the user sees on every launch —
 * and it is the 0xQuantum wallet, which is the point of this build.
 *
 * The main (HD) wallet is unchanged and still reachable at `#/home`.
 */
const DEFAULT_ROUTE: RouteName = "quantum";

export function parseHash(hash: string): Route {
  const raw = hash.replace(/^#\/?/u, "");
  const [path = "", query = ""] = raw.split("?");
  const name = path.split("/")[0] ?? "";
  return {
    name: ROUTES.has(name) ? (name as RouteName) : DEFAULT_ROUTE,
    params: new URLSearchParams(query),
  };
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parseHash(window.location.hash));
  useEffect(() => {
    const onChange = (): void => setRoute(parseHash(window.location.hash));
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return route;
}

export function navigate(path: string): void {
  const next = path.startsWith("#") ? path : `#/${path.replace(/^\//u, "")}`;
  if (window.location.hash === next) return;
  window.location.hash = next;
}

/**
 * "Back" from any screen. Must name `#/home` explicitly rather than `#/`:
 * the bare hash now resolves to DEFAULT_ROUTE (the quantum wallet), so a bare
 * `#/` here would make the back button on the quantum screen a no-op — it would
 * re-enter the screen it is trying to leave. Every other screen's back button
 * would land on quantum too, instead of the main wallet's home.
 */
export function goHome(): void {
  navigate("#/home");
}
