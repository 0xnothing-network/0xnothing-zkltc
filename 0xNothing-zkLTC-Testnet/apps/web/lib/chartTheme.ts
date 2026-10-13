/**
 * Canvas-safe font stack for the lightweight-charts panels.
 *
 * Both charts draw into a `<canvas>`, and `CanvasRenderingContext2D.font` does
 * not resolve CSS custom properties: a value containing `var(--font-num)`
 * parses as an invalid font shorthand, the assignment is discarded, and the axis
 * and crosshair labels silently keep the canvas default sans-serif. next/font
 * also registers hashed family names, so the stack is read from the resolved
 * `--font-num` token (Geist Mono) at chart creation instead of being spelled out here.
 */
const FALLBACK_CHART_FONT = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';

export function chartFontFamily(): string {
  if (typeof document === "undefined") return FALLBACK_CHART_FONT;
  const resolved = getComputedStyle(document.documentElement).getPropertyValue("--font-num").trim();
  return resolved && !resolved.includes("var(") ? `${resolved}, ${FALLBACK_CHART_FONT}` : FALLBACK_CHART_FONT;
}
