import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

/**
 * src/styles/suite/compat.css carries what Android System WebView below 120
 * needs to draw the wallet like a current Chrome: static colours where the
 * sheets use color-mix() (Chromium 111+), and resting values for hover states a
 * tap leaves stuck on a touch screen. These tests keep it honest as the other
 * sheets change: a new color-mix needs a fallback or a stated reason, and every
 * fallback colour is recomputed here from the tokens it stands for.
 */
const STYLES = new URL("../../src/styles/", import.meta.url);
const read = (path: string): string => readFileSync(new URL(path, STYLES), "utf8");
const SHEETS = ["tokens.css", "wallet.css", "suite/onboarding.css", "suite/home.css", "suite/forms.css", "suite/system.css"];
const COMPAT = read("suite/compat.css");
const NO_MIX = "@supports not (color: color-mix(in srgb, red, blue))";

interface Decl { sheet: string; selector: string; prop: string; value: string }

/** Flat declarations with their selector; at-rule preludes are joined with " >> ". */
function declarations(sheet: string, css: string): Decl[] {
  const source = css.replace(/\/\*[\s\S]*?\*\//gu, "");
  const found: Decl[] = [];
  const stack: string[] = [];
  let buffer = "";
  const flush = () => {
    const colon = buffer.indexOf(":");
    if (colon > 0 && stack.length > 0) {
      found.push({
        sheet,
        selector: stack.join(" >> ").replace(/\s+/gu, " "),
        prop: buffer.slice(0, colon).trim(),
        value: buffer.slice(colon + 1).trim(),
      });
    }
    buffer = "";
  };
  for (const ch of source) {
    if (ch === "{") { stack.push(buffer.trim()); buffer = ""; }
    else if (ch === "}") { if (buffer.trim()) flush(); stack.pop(); buffer = ""; }
    else if (ch === ";") flush();
    else buffer += ch;
  }
  return found;
}

/** The body of the first top-level block opened by `prelude` (brace matched). */
function block(css: string, prelude: string): string {
  const start = css.indexOf(prelude);
  assert.notEqual(start, -1, `${prelude} is missing`);
  const open = css.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === "{") depth++;
    if (css[i] === "}" && --depth === 0) return css.slice(open + 1, i);
  }
  throw new Error(`${prelude} is not closed`);
}

const others = SHEETS.flatMap((sheet) => declarations(sheet, read(sheet)));
const fallback = declarations("compat", block(COMPAT, NO_MIX)).map((d) => ({ ...d, selector: d.selector }));

function tokens(sheet: string, selector: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const d of declarations(sheet, read(sheet))) if (d.selector === selector) map.set(d.prop, d.value);
  return map;
}

const hex = (value: string): number[] => {
  assert.match(value, /^#[0-9a-f]{6}$/u, value);
  return [1, 3, 5].map((i) => Number.parseInt(value.slice(i, i + 2), 16));
};
/** color-mix(in srgb, a p, b) of two opaque colours, per channel. */
const mix = (a: string, p: number, b: string): number[] => hex(a).map((v, i) => v * p + hex(b)[i]! * (1 - p));
const triplet = (value: string): number[] => value.split(",").map((part) => Number(part.trim()));

function fallbackValue(selector: string, prop: string): string {
  const d = fallback.find((entry) => entry.selector === selector && entry.prop === prop);
  assert.ok(d, `${selector} { ${prop} } has no fallback`);
  return d.value;
}

test("compat.css is imported after every other stylesheet", () => {
  const main = readFileSync(new URL("../../src/ui/main.tsx", import.meta.url), "utf8");
  const imports = [...main.matchAll(/^import "([^"]+\.css)";$/gmu)].map((match) => match[1]);
  assert.equal(imports.at(-1), "../styles/suite/compat.css");
  for (const sheet of ["wallet.css", "suite/onboarding.css", "suite/home.css", "suite/forms.css", "suite/system.css"]) {
    assert.ok(imports.includes(`../styles/${sheet}`), sheet);
  }
});

test("every color-mix custom property gets a static value without color-mix", () => {
  const props = new Set(others.filter((d) => d.prop.startsWith("--") && d.value.includes("color-mix")).map((d) => d.prop));
  assert.deepEqual([...props].sort(), ["--fi-green-hover", "--ring", "--w-primary-hover"]);
  for (const prop of props) {
    assert.ok(fallback.some((d) => d.prop === prop && !d.value.includes("color-mix")), prop);
  }
});

test("every color-mix declaration is restated, or is already overridden in every engine", () => {
  // Overridden later by a rule of the same or higher specificity: restating
  // them last would bring back a tint the modern engine never shows.
  const superseded = new Set([
    ".w-btn:hover:not(:disabled) border-color",
    ".w-action:hover, .w-action:focus-visible background",
    ".w-earn-lock-option[aria-pressed=\"true\"] background",
    ".w-asset:hover background",
    ".w-max:hover, .w-max:focus-visible background",
    ".w-tx:hover background",
    ".w-dapp:hover background",
    ".w-token-source[data-core=\"true\"] background",
    ".w-account[aria-current=\"true\"] background",
    ".w-input[aria-invalid=\"true\"]:focus box-shadow",
  ]);
  // Restated with a narrower selector, so a later state rule keeps winning.
  const narrowed = new Map([
    [".w-earn-lock-option:hover:not(:disabled), .w-earn-lock-option:focus-visible", ".w-earn-lock-option:hover:not(:disabled):not([aria-pressed=\"true\"])"],
    [".w-select:hover:not(:disabled)", ".w-select:hover:not(:disabled):not(:focus-visible)"],
    [".w-root :is(button, a, [role=\"tab\"]):focus-visible", ".w-root :is(button, a, [role=\"tab\"]):not(.w-seg-item):focus-visible"],
  ]);
  const mixes = others.filter((d) => !d.prop.startsWith("--") && d.value.includes("color-mix"));
  assert.ok(mixes.length >= 20, `only ${mixes.length} color-mix declarations found`);
  for (const d of mixes) {
    if (superseded.has(`${d.selector} ${d.prop}`)) continue;
    const selector = narrowed.get(d.selector) ?? d.selector;
    const value = fallbackValue(selector, d.prop);
    assert.doesNotMatch(value, /color-mix/u);
    // `X p%, transparent` is exactly X at alpha p.
    const [, token, percent] = /color-mix\(in srgb, var\((--[\w-]+)\) (\d+)%, transparent\)/u.exec(d.value) ?? [];
    assert.ok(token, `${d.selector}: ${d.value}`);
    const alpha = Number(percent) / 100;
    const want = `rgba(var(--w-compat-${token.slice(2)}-rgb), ${String(alpha).replace(/^0/u, "")})`;
    assert.ok(value.endsWith(want), `${selector} { ${d.prop}: ${value} } should end with ${want}`);
  }
});

test("the fallback colours are the token colours, per theme and on the NUSD screens", () => {
  const dark = tokens("tokens.css", ".w-root");
  const light = tokens("tokens.css", ".w-root[data-theme=\"light\"]");
  const suiteDark = tokens("wallet.css", ".w-root:not([data-theme=\"light\"])");
  const themes = [
    { selector: ".w-root", t: (name: string) => (name === "--surface-1" ? suiteDark : dark).get(name)! },
    { selector: ".w-root[data-theme=\"light\"]", t: (name: string) => light.get(name) ?? dark.get(name)! },
  ];
  const accent = (theme: (typeof themes)[number]) => theme.t("--accent-hub");
  for (const theme of themes) {
    for (const name of ["text-1", "positive", "negative", "warning", "surface-1"]) {
      assert.deepEqual(triplet(fallbackValue(theme.selector, `--w-compat-${name}-rgb`)), hex(theme.t(`--${name}`)), `${theme.selector} ${name}`);
    }
    assert.deepEqual(triplet(fallbackValue(theme.selector, "--w-compat-accent-rgb")), hex(accent(theme)));
  }
  const close = (got: string, want: number[], label: string) => {
    hex(got).forEach((v, i) => assert.ok(Math.abs(v - want[i]!) <= 0.5 + 1e-9, `${label}: ${got} vs ${want.map((c) => c.toFixed(2))}`));
  };
  const [darkTheme, lightTheme] = themes as [(typeof themes)[number], (typeof themes)[number]];
  // --fi-green-hover: color-mix(in srgb, var(--accent) 85%, var(--text-1)).
  close(fallbackValue(".w-root", "--fi-green-hover"), mix(accent(darkTheme), 0.85, darkTheme.t("--text-1")), "dark hover");
  close(fallbackValue(lightTheme.selector, "--fi-green-hover"), mix(accent(lightTheme), 0.85, lightTheme.t("--text-1")), "light hover");
  // --w-primary-hover, light: color-mix(in srgb, var(--accent) 86%, var(--bg)); dark keeps #c9cdd2.
  close(fallbackValue(lightTheme.selector, "--w-primary-hover"), mix(accent(lightTheme), 0.86, lightTheme.t("--bg")), "light primary");
  // NUSD screens: the accent is --accent-nusd, the primary hover mixes it 88% with --bg.
  for (const [selector, theme] of [
    [".w-root:not([data-theme=\"light\"]):has(.w-earn-flow, .w-mint-flow)", darkTheme],
    [".w-root[data-theme=\"light\"]:has(.w-earn-flow, .w-mint-flow)", lightTheme],
  ] as const) {
    const nusd = theme.t("--accent-nusd");
    assert.deepEqual(triplet(fallbackValue(selector, "--w-compat-accent-rgb")), hex(nusd), selector);
    close(fallbackValue(selector, "--fi-green-hover"), mix(nusd, 0.85, theme.t("--text-1")), `${selector} hover`);
    close(fallbackValue(selector, "--w-primary-hover"), mix(nusd, 0.88, theme.t("--bg")), `${selector} primary`);
  }
});

test("engines with color-mix never see a fallback", () => {
  // Every --w-compat-* use sits inside a `@supports not (color-mix)` block.
  for (const d of declarations("compat", COMPAT)) {
    if (!`${d.prop} ${d.value}`.includes("--w-compat-")) continue;
    assert.ok(d.selector.includes(NO_MIX), `${d.selector} { ${d.prop} } is outside ${NO_MIX}`);
  }
  for (const sheet of SHEETS) assert.doesNotMatch(read(sheet), /--w-compat-/u, sheet);
});

test("touch screens restate resting values only for hover states", () => {
  const touch = declarations("compat", block(COMPAT, "@media (hover: none)"));
  assert.ok(touch.length >= 15);
  for (const d of touch) {
    const selector = d.selector.split(" >> ").at(-1)!;
    // Top-level commas only: `:not(:disabled, [aria-pressed])` is one selector.
    for (const part of selector.split(/,(?![^(]*\))/u)) assert.match(part, /:hover/u, selector);
  }
  const rule = (selector: string) => new Map(touch.filter((d) => d.selector === selector).map((d) => [d.prop, d.value]));
  // Default, primary and danger buttons come back to their resting look.
  assert.deepEqual(rule(".w-btn:hover:not(:disabled)"), new Map([["border-color", "var(--line)"], ["background", "var(--surface-2)"]]));
  assert.equal(rule(".w-btn[data-variant=\"primary\"]:hover:not(:disabled)").get("border-color"), "transparent");
  assert.equal(rule(".w-root .w-btn[data-variant=\"primary\"]:hover:not(:disabled)").get("background"), "var(--accent)");
  assert.equal(rule(".w-btn[data-variant=\"danger\"]:hover:not(:disabled)").get("background"), "var(--surface-1)");
  // The existing hover rules are untouched: they still hold for a mouse.
  assert.ok(others.some((d) => d.selector === ".w-btn:hover:not(:disabled)" && d.value === "var(--surface-3)"));
});

test("the touch hit areas reach 44px on the controls measured below it", () => {
  const coarse = declarations("system.css", block(read("suite/system.css"), "@media (pointer: coarse)"));
  const inset = (selector: string): number[] => {
    const value = coarse.find((d) => d.selector.endsWith(selector) && d.prop === "inset")?.value;
    assert.ok(value, selector);
    const parts = value.split(/\s+/u).map((part) => -Number.parseFloat(part));
    const [top = 0, , bottom = top] = parts;
    return [top, bottom];
  };
  // Line boxes as drawn: Max 16px, the Home address 16px, the Receive link 24px, the danger row 30px.
  for (const [selector, height] of [
    [".w-root .w-max::before", 16],
    [".w-root .w-home .w-address::before", 16],
    [".w-root .w-recv > .w-btn[data-variant=\"ghost\"]::before", 24],
    [".w-root .w-settings .w-panel[data-tone=\"danger\"] > .w-panel-body > .w-btn::before", 30],
  ] as const) {
    const [top, bottom] = inset(selector);
    assert.ok(height + top! + bottom! >= 44, `${selector}: ${height + top! + bottom!}px`);
  }
});
