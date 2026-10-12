/** Join truthy class names. Tiny stand-in for clsx so primitives add no deps. */
export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

/**
 * Class to put on the root of any new-system island rendered inside legacy
 * product CSS (.fi-root / .pump-shell / .pixel-product). See app/styles/theme.css.
 */
export const UI_ISLAND = "ui";
