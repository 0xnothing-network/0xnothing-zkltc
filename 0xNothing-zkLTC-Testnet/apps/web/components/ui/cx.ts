/** Join truthy class names. Tiny stand-in for clsx so primitives add no deps. */
export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}
