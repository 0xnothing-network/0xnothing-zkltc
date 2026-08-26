/**
 * Canvas-safe font stack for the lightweight-charts panels.
 *
 * Both charts draw into a `<canvas>`, and `CanvasRenderingContext2D.font` does
 * not resolve CSS custom properties: a value containing `var(--font-departure)`
 * parses as an invalid font shorthand, the assignment is discarded, and the axis
 * and crosshair labels silently keep the canvas default sans-serif. So the stack
 * has to be spelled out literally.
 *
 * Keep this string equal to `--font-departure` in app/globals.css — that is the
 * value the rest of the interface renders with, and the charts sit inside it.
 */
export const CHART_FONT_FAMILY =
  '"Departure Mono", ui-monospace, SFMono-Regular, monospace';
