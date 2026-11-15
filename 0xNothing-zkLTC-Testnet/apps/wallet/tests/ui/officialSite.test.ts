import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { domainToASCII } from "node:url";
import { OFFICIAL_SITE_DOMAINS, OFFICIAL_SITE_HOSTS, PUBLIC_APP_URL } from "../../src/config/dapps.ts";
import { siteMark } from "../../src/ui/lib/officialSite.ts";

test("exactly the four official hosts over https get the official mark", () => {
  for (const origin of [
    "https://0xnothing.xyz",
    "https://0xnothing.app",
    "https://0xnothing.network",
    "https://www.0xnothing.network",
    "https://0xNothing.App.",
  ]) {
    assert.equal(siteMark(origin), "official", origin);
  }
  // Same name without https, or on another port, is not the secure site.
  assert.equal(siteMark("http://0xnothing.app"), "lookalike");
  assert.equal(siteMark("https://0xnothing.xyz:8443"), "lookalike");
  // Hosts that were never listed get no mark.
  assert.equal(siteMark("https://www.0xnothing.app"), "none");
  assert.equal(OFFICIAL_SITE_HOSTS.length, 4);
});

test("the official list matches the web app's routes and PUBLIC_APP_URL", () => {
  const wrangler = readFileSync(new URL("../../../web/wrangler.jsonc", import.meta.url), "utf8");
  const routes = [...wrangler.matchAll(/"pattern":\s*"([^"]+)"/g)].map((match) => match[1]);
  const publicConfig = readFileSync(new URL("../../../web/lib/publicConfig.ts", import.meta.url), "utf8");
  const webAppUrl = /PUBLIC_APP_URL\s*=\s*"([^"]+)"/.exec(publicConfig)?.[1];
  assert.equal(webAppUrl, PUBLIC_APP_URL);
  // PUBLIC_APP_URL's host is itself a route, so the two sources overlap.
  assert.deepEqual(
    [...OFFICIAL_SITE_HOSTS].sort(),
    [...new Set([new URL(PUBLIC_APP_URL).hostname, ...routes])].sort(),
  );
  // Every official host sits under one of the registrable domains.
  for (const host of OFFICIAL_SITE_HOSTS) {
    assert.ok(OFFICIAL_SITE_DOMAINS.some((domain) => host === domain || host.endsWith(`.${domain}`)), host);
  }
});

test("an official name used as a label of another domain is a look-alike", () => {
  for (const origin of [
    "https://0xnothing.app.evil.com",
    "https://0xnothing.com",
    "https://0xnothing-app.io",
    "https://0x-nothing.io",
    "https://login.0xnothing.network.example",
    "https://app-0xnothing.xyz.example",
  ]) {
    assert.equal(siteMark(origin), "lookalike", origin);
  }
});

test("homoglyph and punycode hosts are look-alikes", () => {
  for (const name of ["0хnothing.app", "0xnóthing.app", "0xnοthing.network", "охnothing.xyz", "0xnothіng.app"]) {
    const ascii = domainToASCII(name);
    assert.match(ascii, /xn--/, name);
    assert.equal(siteMark(`https://${ascii}`), "lookalike", name);
    // The URL parser turns the Unicode form into the same ASCII host.
    assert.equal(siteMark(`https://${name}`), "lookalike", name);
  }
  // Fullwidth letters are mapped by the URL parser itself to the real host.
  assert.equal(siteMark("https://０ｘｎｏｔｈｉｎｇ.app"), "official");
  assert.equal(siteMark("https://０ｘｎｏｔｈｉｎｇ.com"), "lookalike");
});

test("near misses within the edit distance are look-alikes", () => {
  for (const origin of [
    "https://0xnothng.app",
    "https://0xnohting.app",
    "https://oxnothing.network",
    "https://0xnotthing.xyz",
    "https://xnothing.app",
    "https://0xn0thin.io",
    "https://Oxnothing.app",
  ]) {
    assert.equal(siteMark(origin), "lookalike", origin);
  }
});

test("owner subdomains are neither", () => {
  assert.equal(siteMark("https://docs.0xnothing.app"), "none");
  assert.equal(siteMark("https://api.0xnothing.network"), "none");
  assert.equal(siteMark("https://beta.0xnothing.xyz"), "none");
});

test("unrelated sites are neither", () => {
  for (const origin of [
    "https://nothing.tech",
    "https://uniswap.org",
    "http://localhost:5173",
    "http://127.0.0.1:8080",
    "http://[::1]:3000",
    "https://app.example",
    "https://nothing-phone.com",
    "https://something.io",
  ]) {
    assert.equal(siteMark(origin), "none", origin);
  }
});

test("siteMark never throws", () => {
  const inputs: unknown[] = [
    "",
    "not a url",
    "chrome-extension://abc",
    "file:///C:/x.html",
    "javascript:alert(1)",
    "https://xn--.app",
    "https://xn--zzzzzzzzzzzz.app",
    `https://${"a".repeat(60)}.${"b".repeat(60)}.${"c".repeat(60)}.com`,
    `https://${"x".repeat(5000)}.com`,
    null,
    undefined,
    42,
    {},
  ];
  for (const input of inputs) {
    assert.doesNotThrow(() => siteMark(input as string));
    assert.ok(["official", "lookalike", "none"].includes(siteMark(input as string)));
  }
});
