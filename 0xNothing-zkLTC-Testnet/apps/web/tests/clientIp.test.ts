import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeIp,
  rightmostForwardedIp,
  trustedProxyClientKey,
} from "../lib/server/clientIp.ts";

test("normalizeIp accepts proxy IP formats and rejects arbitrary text", () => {
  assert.equal(normalizeIp('"203.0.113.9"'), "203.0.113.9");
  assert.equal(normalizeIp("203.0.113.9:443"), "203.0.113.9");
  assert.equal(normalizeIp("[2001:DB8::9]:443"), "2001:db8::9");
  assert.equal(normalizeIp("not-an-ip"), undefined);
});

test("rightmostForwardedIp selects the proxy-adjacent valid entry", () => {
  assert.equal(
    rightmostForwardedIp("198.51.100.1, unknown, 203.0.113.7"),
    "203.0.113.7",
  );
});

test("trustedProxyClientKey ignores spoofable forwarding headers by default", () => {
  const request = new Request("https://example.test", {
    headers: { "x-forwarded-for": "203.0.113.7" },
  });
  assert.equal(trustedProxyClientKey(request, undefined, false), "unidentified-client");
  assert.equal(
    trustedProxyClientKey(request, "x-forwarded-for", false),
    "x-forwarded-for:203.0.113.7",
  );
  assert.equal(trustedProxyClientKey(request, undefined, true), "vercel:203.0.113.7");
});
