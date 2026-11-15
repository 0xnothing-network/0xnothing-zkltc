import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import config from "../../capacitor.config.ts";

const walletFile = (path: string): string => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

test("the Capacitor bridge never logs plugin calls, in any build", () => {
  // A debug build's default ("debug") writes every plugin result to logcat,
  // the encrypted vault record and the account list among them.
  assert.equal(config.loggingBehavior, "none");
  assert.equal(config.android?.loggingBehavior, undefined, "an android override would replace the global value");
  // The global fetch patch stays off.
  assert.deepEqual(config.plugins?.CapacitorHttp, { enabled: false });
});

test("the stylesheet keeps the -webkit- prefixes older Android WebViews need", () => {
  // At the chrome120 JS target the CSS minifier drops -webkit-mask, and a
  // WebView below 120 then paints the chevrons as solid squares.
  const vite = walletFile("vite.config.ts");
  assert.match(vite, /^\s*target: "chrome120",$/mu);
  assert.match(vite, /^\s*cssTarget: "chrome105",$/mu);
  const css = walletFile("src/styles/wallet.css");
  assert.ok((css.match(/^\s*-webkit-mask: /gmu) ?? []).length >= 2);
});
