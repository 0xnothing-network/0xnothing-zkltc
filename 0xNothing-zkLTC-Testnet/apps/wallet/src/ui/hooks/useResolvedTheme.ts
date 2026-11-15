import { useEffect, useState } from "react";
import { type ResolvedTheme, resolveTheme, SYSTEM_LIGHT_QUERY, systemPrefersLight } from "../lib/theme";

/**
 * The theme the stylesheets see. Only the "system" setting listens to the OS,
 * so a fixed choice adds no listener; a switch of the OS while the wallet is
 * open repaints it, and the document root follows so the early-paint colour
 * under the shell matches.
 */
export function useResolvedTheme(theme: string): ResolvedTheme {
  const [prefersLight, setPrefersLight] = useState(systemPrefersLight);

  useEffect(() => {
    if (theme !== "system" || typeof matchMedia !== "function") return undefined;
    let query: MediaQueryList;
    try {
      query = matchMedia(SYSTEM_LIGHT_QUERY);
    } catch {
      return undefined;
    }
    const sync = (): void => {
      setPrefersLight(query.matches);
      try {
        document.documentElement.dataset.theme = resolveTheme("system", query.matches);
      } catch {
        // The .w-root attribute below still carries the theme.
      }
    };
    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, [theme]);

  return resolveTheme(theme, prefersLight);
}
