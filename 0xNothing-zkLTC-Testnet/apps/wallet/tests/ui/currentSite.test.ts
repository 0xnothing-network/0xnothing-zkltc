import assert from "node:assert/strict";
import { test } from "node:test";
import { currentSiteStatus, siteOrigin } from "../../src/ui/lib/currentSite.ts";

const A = "0x1111111111111111111111111111111111111111";
const B = "0x2222222222222222222222222222222222222222";

test("only an http(s) tab has a site, shown by its origin alone", () => {
  assert.equal(siteOrigin("https://app.example.test/swap?x=1#top"), "https://app.example.test");
  assert.equal(siteOrigin("http://localhost:5173/"), "http://localhost:5173");
  assert.equal(siteOrigin("https://APP.Example.test:443/"), "https://app.example.test");
  assert.equal(siteOrigin("https://user:pass@app.example.test/"), "https://app.example.test");
  assert.equal(siteOrigin("chrome://newtab/"), null);
  assert.equal(siteOrigin("chrome-extension://abc/index.html"), null);
  assert.equal(siteOrigin("about:blank"), null);
  assert.equal(siteOrigin("file:///C:/page.html"), null);
  assert.equal(siteOrigin("not a url"), null);
  assert.equal(siteOrigin(""), null);
  assert.equal(siteOrigin(undefined), null);
});

test("the status names the granted account the site sees now", () => {
  const book = [
    { origin: "https://app.example.test", accounts: [A, B] as `0x${string}`[], at: 1 },
    { origin: "https://other.example.test", accounts: [B] as `0x${string}`[], at: 2 },
  ];
  assert.deepEqual(currentSiteStatus("https://app.example.test", book, A), {
    origin: "https://app.example.test",
    connected: true,
    account: A,
  });
  // The active account is matched case-insensitively, the grant's own spelling is shown.
  assert.equal(currentSiteStatus("https://app.example.test", book, B.toUpperCase().replace("0X", "0x")).account, B);
  // Granted, but not to the account in use: connected, and it sees no one.
  assert.deepEqual(currentSiteStatus("https://other.example.test", book, A), {
    origin: "https://other.example.test",
    connected: true,
    account: null,
  });
  assert.deepEqual(currentSiteStatus("https://new.example.test", book, A), {
    origin: "https://new.example.test",
    connected: false,
    account: null,
  });
  // A look-alike origin is not the granted one.
  assert.equal(currentSiteStatus("http://app.example.test", book, A).connected, false);
});
