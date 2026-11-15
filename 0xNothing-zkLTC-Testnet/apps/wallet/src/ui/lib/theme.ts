/**
 * The appearance setting is dark, light or system; the stylesheets only know
 * dark and light. "system" follows the operating system's choice, which the
 * page reads from the prefers-color-scheme media query. Import-free so the
 * tests can load it directly; public/theme-boot.js repeats this rule for the
 * paint before the bundle runs.
 */
export type ResolvedTheme = "dark" | "light";

export const SYSTEM_LIGHT_QUERY = "(prefers-color-scheme: light)";

export function resolveTheme(theme: string, prefersLight: boolean): ResolvedTheme {
  if (theme === "light") return "light";
  if (theme === "system") return prefersLight ? "light" : "dark";
  return "dark";
}

/** False where the query cannot be asked (tests, an old WebView): dark stays the safe default. */
export function systemPrefersLight(): boolean {
  try {
    return typeof matchMedia === "function" && matchMedia(SYSTEM_LIGHT_QUERY).matches;
  } catch {
    return false;
  }
}
