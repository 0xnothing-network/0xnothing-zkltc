import { useSyncExternalStore } from "react";

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

export interface ChartPalette {
  background: string;
  text: string;
  grid: string;
  border: string;
  crosshair: string;
  up: string;
  down: string;
  upVolume: string;
  downVolume: string;
}

/**
 * Chart colours from the theme tokens. A canvas cannot read `var(--x)` either, so the
 * resolved values are passed in, and a chart is rebuilt when `useThemeName` changes.
 */
export function chartPalette(): ChartPalette {
  const style = typeof document === "undefined" ? null : getComputedStyle(document.documentElement);
  const token = (name: string) => style?.getPropertyValue(name).trim() ?? "";
  const ink = token("--text-1");
  const up = token("--positive");
  const down = token("--negative");
  return {
    background: token("--bg"),
    text: token("--text-3"),
    grid: withAlpha(ink, 0.05),
    border: withAlpha(ink, 0.1),
    crosshair: token("--text-3"),
    up,
    down,
    upVolume: withAlpha(up, 0.28),
    downVolume: withAlpha(down, 0.28),
  };
}

// shortcut: handles the #rrggbb form app/tokens.css uses; any other form passes through opaque.
function withAlpha(hex: string, alpha: number): string {
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!match) return hex;
  const [r, g, b] = match.slice(1).map((part) => parseInt(part, 16));
  return `rgba(${r},${g},${b},${alpha})`;
}

function subscribeTheme(onChange: () => void): () => void {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  return () => observer.disconnect();
}

/** The `<html data-theme>` value; re-renders when ThemeToggle flips it. */
export function useThemeName(): string {
  return useSyncExternalStore(
    subscribeTheme,
    () => document.documentElement.dataset.theme ?? "dark",
    () => "dark",
  );
}
