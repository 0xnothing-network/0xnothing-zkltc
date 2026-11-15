import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { backAction, type RouteName } from "../../src/ui/router.ts";

const read = (path: string): string => readFileSync(new URL(`../../src/ui/${path}`, import.meta.url), "utf8");

test("Back closes an open sheet first, on any route", () => {
  for (const route of ["home", "send", "swap", "settings"] satisfies RouteName[]) {
    assert.equal(backAction({ ready: true, route, modalOpen: true }), "escape");
  }
});

test("Back returns to Home from a pushed or tab screen", () => {
  for (const route of ["send", "receive", "history", "mint", "earn", "lend", "swap", "dapps", "settings"] satisfies RouteName[]) {
    assert.equal(backAction({ ready: true, route, modalOpen: false }), "home");
  }
});

test("Back leaves from Home, the approval route and before the vault opens", () => {
  assert.equal(backAction({ ready: true, route: "home", modalOpen: false }), "leave");
  assert.equal(backAction({ ready: true, route: "approve", modalOpen: false }), "leave");
  // Onboarding and the lock screen: not ready, whatever the hash or an open sheet says.
  assert.equal(backAction({ ready: false, route: "send", modalOpen: false }), "leave");
  assert.equal(backAction({ ready: false, route: "home", modalOpen: true }), "leave");
});

test("App exposes __walletBack on Android only and maps the action to a boolean", () => {
  const app = read("App.tsx");
  assert.match(app, /if \(!isAndroid\) return undefined;\s*window\.__walletBack = \(\): boolean =>/u);
  assert.match(app, /document\.querySelector\('\[aria-modal="true"\]'\) !== null/u);
  assert.match(app, /new KeyboardEvent\("keydown", \{ key: "Escape" \}\)\);\s*return true;/u);
  assert.match(app, /goHome\(\);\s*return true;\s*\}\s*return false;/u);
  assert.match(app, /delete window\.__walletBack;/u);
});

test("every sheet that Back may find is a modal closed by Escape on window", () => {
  for (const file of ["components/AccountSheet.tsx", "components/SwapTokenPicker.tsx", "components/TransactionReview.tsx", "screens/Lend.tsx", "screens/Swap.tsx"]) {
    const source = read(file);
    assert.match(source, /aria-modal="true"/u, file);
    assert.match(source, /window\.addEventListener\("keydown"/u, file);
  }
});

test("Receive hides Save QR on Android, where the WebView drops downloads", () => {
  assert.match(read("screens/Receive.tsx"), /\{qrDataUrl && !isAndroid \? \(/u);
});
