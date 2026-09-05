import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  customNetworkId,
  sanitizeCustomNetwork,
  viemChainFor,
  type WalletNetwork,
} from "../../src/config/networks.ts";

const manifest = JSON.parse(
  readFileSync(new URL("../../public/manifest.json", import.meta.url), "utf8"),
) as {
  minimum_chrome_version?: string;
  name?: string;
  short_name?: string;
  version?: string;
  host_permissions?: string[];
  action?: { default_title?: string };
};
const pkg = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
) as { version?: string };
const viteConfig = readFileSync(new URL("../../vite.config.ts", import.meta.url), "utf8");
const injectBuild = readFileSync(new URL("../../scripts/build-inject.mjs", import.meta.url), "utf8");

test("the extension minimum Chrome matches both production bundle targets", () => {
  assert.equal(manifest.minimum_chrome_version, "120");
  assert.match(viteConfig, /target:\s*["']chrome120["']/u);
  assert.match(injectBuild, /target:\s*["']chrome120["']/u);
});

test("the extension ships one version number, in a form the Web Store accepts", () => {
  // Two hand-maintained copies of the same number: the Web Store reads
  // public/manifest.json, while vite.config.ts stamps package.json's version into
  // __WALLET_VERSION__ for the Settings screen. Let them drift and the installed
  // extension reports a version it was never published under.
  assert.equal(manifest.version, pkg.version);
  // Chrome accepts one to four dot-separated integers, no leading zeroes and no
  // pre-release suffix — a plain semver tag like "1.0.1-rc.1" is refused at upload
  // time, which is far too late to find out.
  const version = manifest.version ?? "";
  assert.match(version, /^(?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*)){0,3}$/u);
  for (const part of version.split(".")) assert.ok(Number(part) <= 65_535);
});

test("extension branding and market API permission stay explicit", () => {
  assert.equal(manifest.name, "0xWallet");
  assert.equal(manifest.short_name, "0xWallet");
  assert.equal(manifest.action?.default_title, "0xWallet");
  assert.ok(manifest.host_permissions?.includes("https://0xnothing.xyz/*"));
  assert.ok(manifest.host_permissions?.includes("https://api.goldsky.com/*"));
  const viMessages = JSON.parse(
    readFileSync(new URL("../../public/_locales/vi/messages.json", import.meta.url), "utf8"),
  ) as { extDescription?: { message?: string } };
  assert.equal(viMessages.extDescription?.message, "0xNothing Wallet");
});

test("persisted custom networks cannot supply a cache-aliasing id", () => {
  const rpcUrl = "https://rpc.example.test/";
  const network = sanitizeCustomNetwork({
    id: "custom-999-aaa",
    name: "Example",
    chainId: 999,
    rpcUrl,
    nativeCurrency: { name: "Example", symbol: "EX", decimals: 18 },
  });
  assert.ok(network);
  assert.equal(network.id, customNetworkId(999, rpcUrl));
  assert.notEqual(network.id, "custom-999-aaa");
});

test("custom RPC profiles cannot turn a pasted hostname into wildcard access", () => {
  assert.equal(sanitizeCustomNetwork({
    name: "Wildcard",
    chainId: 998,
    rpcUrl: "https://*.example.test/",
    nativeCurrency: { name: "Wildcard", symbol: "WILD", decimals: 18 },
  }), null);
});

test("viem chain caching uses the full custom-network identity", () => {
  const base: WalletNetwork = {
    id: "custom-999-deadbeef",
    name: "First",
    chainId: 999,
    rpcUrl: "https://rpc-one.example.test/",
    explorerUrl: "",
    nativeCurrency: { name: "First", symbol: "ONE", decimals: 18 },
    builtin: false,
  };
  const changed = {
    ...base,
    name: "Second",
    rpcUrl: "https://rpc-two.example.test/",
    nativeCurrency: { name: "Second", symbol: "TWO", decimals: 18 },
  };
  const first = viemChainFor(base);
  const second = viemChainFor(changed);
  assert.notStrictEqual(first, second);
  assert.equal(first.rpcUrls.default.http[0], base.rpcUrl);
  assert.equal(second.rpcUrls.default.http[0], changed.rpcUrl);
});
