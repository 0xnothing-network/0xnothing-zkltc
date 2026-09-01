import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeIp,
  rightmostForwardedIp,
  trustedClientRateLimitKey,
  trustedProxyClientKey,
  trustedProxyRequest,
} from "../../lib/server/clientIp.ts";

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
    headers: {
      "cf-connecting-ip": "198.51.100.4",
      "x-forwarded-for": "203.0.113.7",
    },
  });
  assert.equal(trustedProxyClientKey(request, undefined, false), "unidentified-client");
  assert.equal(
    trustedProxyClientKey(request, "x-forwarded-for", false),
    "x-forwarded-for:203.0.113.7",
  );
  assert.equal(trustedProxyClientKey(request, undefined, true), "vercel:203.0.113.7");
});

test("an unidentified proxy client never becomes a shared IP rate-limit bucket", () => {
  assert.equal(trustedClientRateLimitKey("unidentified-client"), null);
  assert.equal(
    trustedClientRateLimitKey("vercel:203.0.113.7"),
    "ip:vercel:203.0.113.7",
  );
});

test("trustedProxyClientKey authenticates a Cloudflare-provided client IP", () => {
  const secret = "test-only-cloudflare-origin-secret";
  const request = new Request("https://example.test", {
    headers: {
      "cf-connecting-ip": "2001:db8::7",
      "x-0xnothing-proxy-secret": secret,
    },
  });

  assert.equal(
    trustedProxyClientKey(request, "cf-connecting-ip", false, secret),
    "cf-connecting-ip:2001:db8::7",
  );
});

test("trustedProxyClientKey never trusts Cloudflare client IPs without origin authentication", () => {
  const request = new Request("https://example.test", {
    headers: { "cf-connecting-ip": "203.0.113.8" },
  });

  assert.equal(
    trustedProxyClientKey(request, "cf-connecting-ip", false),
    "unidentified-client",
  );
});

test("trustedProxyClientKey trusts Cloudflare client IPs inside the Worker runtime", () => {
  const request = new Request("https://example.test", {
    headers: { "cf-connecting-ip": "203.0.113.8" },
  });

  assert.equal(
    trustedProxyClientKey(request, "cf-connecting-ip", false, undefined, true),
    "cf-connecting-ip:203.0.113.8",
  );
});

test("trustedProxyClientKey rejects a configured proxy header without the shared secret", () => {
  const missingSecret = new Request("https://example.test", {
    headers: { "cf-connecting-ip": "203.0.113.9" },
  });
  const wrongSecret = new Request("https://example.test", {
    headers: {
      "cf-connecting-ip": "203.0.113.9",
      "x-0xnothing-proxy-secret": "wrong-secret",
    },
  });

  assert.equal(
    trustedProxyClientKey(missingSecret, "cf-connecting-ip", false, "expected-secret"),
    "unidentified-client",
  );
  assert.equal(
    trustedProxyClientKey(wrongSecret, "cf-connecting-ip", false, "expected-secret"),
    "unidentified-client",
  );
});

test("trustedProxyRequest enables the guard only when a secret is configured", () => {
  const request = new Request("https://example.test", {
    headers: { "x-0xnothing-proxy-secret": "expected-secret" },
  });

  assert.equal(trustedProxyRequest(request, undefined), true);
  assert.equal(trustedProxyRequest(request, "  "), true);
  assert.equal(trustedProxyRequest(request, "expected-secret"), true);
  assert.equal(trustedProxyRequest(request, "different-secret"), false);
});

test("trustedProxyRequest rejects oversized proxy secrets before comparison", () => {
  const oversized = "x".repeat(257);
  const request = new Request("https://example.test", {
    headers: { "x-0xnothing-proxy-secret": oversized },
  });

  assert.equal(trustedProxyRequest(request, oversized), false);
  assert.equal(trustedProxyRequest(request, "expected-secret"), false);
});
