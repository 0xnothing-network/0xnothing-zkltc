import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const manifest = JSON.parse(
  readFileSync(new URL("../public/manifest.json", import.meta.url), "utf8"),
) as {
  minimum_chrome_version?: string;
  name?: string;
  short_name?: string;
  host_permissions?: string[];
  action?: { default_title?: string };
};
const viteConfig = readFileSync(new URL("../vite.config.ts", import.meta.url), "utf8");
const injectBuild = readFileSync(new URL("../scripts/build-inject.mjs", import.meta.url), "utf8");

test("the extension minimum Chrome matches both production bundle targets", () => {
  assert.equal(manifest.minimum_chrome_version, "120");
  assert.match(viteConfig, /target:\s*["']chrome120["']/u);
  assert.match(injectBuild, /target:\s*["']chrome120["']/u);
});

test("extension branding and market API permission stay explicit", () => {
  assert.equal(manifest.name, "0xWallet");
  assert.equal(manifest.short_name, "0xWallet");
  assert.equal(manifest.action?.default_title, "0xWallet");
  assert.ok(manifest.host_permissions?.includes("https://0xnothing.xyz/*"));
  assert.ok(manifest.host_permissions?.includes("https://api.goldsky.com/*"));
  const viMessages = JSON.parse(
    readFileSync(new URL("../public/_locales/vi/messages.json", import.meta.url), "utf8"),
  ) as { extDescription?: { message?: string } };
  assert.equal(viMessages.extDescription?.message, "0xNothing Wallet");
});
