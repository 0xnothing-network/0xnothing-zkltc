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
  | "lend"
  | "swap"
  | "dapps"
  | "settings"
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
  "lend",
  "swap",
  "dapps",
  "settings",
  "approve",
]);

export function parseHash(hash: string): Route {
  const raw = hash.replace(/^#\/?/u, "");
  const [path = "", query = ""] = raw.split("?");
  const name = path.split("/")[0] ?? "";
  return {
    name: ROUTES.has(name) ? (name as RouteName) : "home",
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

export function goHome(): void {
  navigate("#/");
}
