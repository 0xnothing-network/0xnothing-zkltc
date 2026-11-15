import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const read = (path: string): string => readFileSync(new URL(`../../src/ui/${path}`, import.meta.url), "utf8");

test("Lend says an unread pool figure could not be read instead of showing a zero", () => {
  const lend = read("screens/Lend.tsx");
  assert.match(
    lend,
    /state\.supplied === null \|\| state\.maxWithdraw === null \|\| state\.availableLiquidity === null\) \? \(\s*<Note tone="warn">\{t\("lend\.readError"\)\}<\/Note>/u,
  );
  // An unread cap still blocks the withdrawal.
  assert.match(lend, /!state\.activated \|\| state\.maxWithdraw === null;/u);
});

test("Add account selects the account addHdAccount made active, not the last row", () => {
  const sheet = read("components/AccountSheet.tsx");
  assert.match(sheet, /const state = await addHdAccount\(\);[\s\S]*?if \(state\.active\) await selectAccount\(state\.active\);\s*else await reload\(\);/u);
  assert.doesNotMatch(sheet, /state\.accounts\[state\.accounts\.length - 1\]/u);
});

test("Dapps lists every granted account of a site, one per line", () => {
  const dapps = read("screens/Dapps.tsx");
  assert.match(dapps, /t\("dapp\.grantedAccounts"\)/u);
  assert.match(dapps, /entry\.accounts\.map\(\(account\) => \{/u);
  assert.match(dapps, /className="w-asset-sub w-dapp-account" title=\{account\}/u);
});

test("revealed words and keys are not selectable on Android, still selectable elsewhere", () => {
  const css = readFileSync(new URL("../../src/styles/suite/onboarding.css", import.meta.url), "utf8");
  const rule = /\.w-root\[data-platform="android"\] :is\(\.w-seed, \.w-word, \.w-secret\) \{([^}]*)\}/u.exec(css);
  assert.ok(rule, "android rule");
  assert.match(rule[1]!, /-webkit-user-select: none;/u);
  assert.match(rule[1]!, /\buser-select: none;/u);
  assert.match(rule[1]!, /-webkit-touch-callout: none;/u);
  assert.match(read("App.tsx"), /data-platform=\{platform\}/u);
  assert.match(read("screens/settings/RevealSecrets.tsx"), /<p className="w-code w-mono-break w-secret">\{secret\}<\/p>/u);
  assert.match(read("screens/Onboarding.tsx"), /<div className="w-seed">/u);
});
