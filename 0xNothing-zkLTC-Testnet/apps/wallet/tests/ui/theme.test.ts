import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { resolveTheme, systemPrefersLight } from "../../src/ui/lib/theme.ts";

/** F20: the System appearance and the account sheet's Lock now. */
const source = (path: string): string => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

test("system follows the OS; dark stays the default for anything unknown", () => {
  assert.equal(resolveTheme("system", true), "light");
  assert.equal(resolveTheme("system", false), "dark");
  assert.equal(resolveTheme("light", false), "light");
  assert.equal(resolveTheme("dark", true), "dark");
  assert.equal(resolveTheme("sepia", true), "dark");
  assert.equal(resolveTheme("", true), "dark");
  // Node has no matchMedia: the safe answer is "not light".
  assert.equal(systemPrefersLight(), false);
});

test("settings keep system, the mirror keeps the setting and the root gets the resolved theme", () => {
  const vault = source("src/core/keyring/vault.ts");
  assert.match(vault, /export type WalletTheme = "dark" \| "light" \| "system";/u);
  assert.match(vault, /merged\.theme !== "light" && merged\.theme !== "dark" && merged\.theme !== "system"/u);
  const context = source("src/ui/state/WalletContext.tsx");
  assert.match(context, /dataset\.theme = resolveTheme\(theme, systemPrefersLight\(\)\)/u);
  assert.match(context, /localStorage\.setItem\(THEME_STORAGE_KEY, theme\)/u);
  const app = source("src/ui/App.tsx");
  assert.match(app, /const theme = useResolvedTheme\(settings\.theme\);/u);
  assert.match(app, /data-theme=\{theme\}/u);
  const settings = source("src/ui/screens/Settings.tsx");
  assert.match(settings, /\["dark", "light", "system"\] as const/u);
  assert.match(settings, /t\("set\.system"\)/u);
});

test("the early paint resolves system the same way, before the bundle runs", () => {
  const boot = source("public/theme-boot.js");
  const html = (stored: string | null, light: boolean): string | undefined => {
    const root = { dataset: {} as Record<string, string> };
    const run = new Function("localStorage", "document", "window", boot);
    run(
      { getItem: () => stored },
      { documentElement: root },
      { matchMedia: () => ({ matches: light }) },
    );
    return root.dataset.theme;
  };
  assert.equal(html("system", true), "light");
  assert.equal(html("system", false), "dark");
  assert.equal(html("light", false), "light");
  assert.equal(html("dark", true), "dark");
  assert.equal(html(null, true), undefined);
  assert.equal(html("junk", true), undefined);
});

test("the account sheet always offers Lock now, through the wallet's own lock", () => {
  const sheet = source("src/ui/components/AccountSheet.tsx");
  assert.doesNotMatch(sheet, /panelOffered \|\| tabOffered/u);
  assert.match(sheet, /await lockWallet\(\);/u);
  assert.match(sheet, /onClick=\{\(\) => void lockNow\(\)\}/u);
  assert.match(sheet, /t\("set\.lockNow"\)/u);
});
