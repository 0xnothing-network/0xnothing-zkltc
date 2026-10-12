import assert from "node:assert/strict";
import test from "node:test";
import {
  FIRST_PARTY_EXTERNAL_REL,
  USER_EXTERNAL_REL,
  isValidExternalHref,
  normalizeExternalHref,
} from "../../lib/safeExternalHref.ts";

test("normalizeExternalHref keeps ordinary https URLs", () => {
  assert.equal(normalizeExternalHref("https://example.org/path?q=1"), "https://example.org/path?q=1");
  assert.equal(isValidExternalHref("https://docs.example.org"), true);
});

test("normalizeExternalHref rejects javascript, http, credentials, ports, and local hosts", () => {
  for (const value of [
    "javascript:alert(1)",
    "http://example.org",
    "https://user:pass@example.org",
    "https://example.org:8080",
    "https://localhost/admin",
    "https://router.home.arpa",
    "https://127.0.0.1/",
    "https://[::1]/",
    "https://intranet",
    "",
    "not a url",
  ]) {
    assert.equal(normalizeExternalHref(value), "", value);
    assert.equal(isValidExternalHref(value), false, value);
  }
});

test("external link rel values keep tab-nabbing closed", () => {
  assert.match(FIRST_PARTY_EXTERNAL_REL, /noopener/);
  assert.match(FIRST_PARTY_EXTERNAL_REL, /noreferrer/);
  assert.match(USER_EXTERNAL_REL, /noopener/);
  assert.match(USER_EXTERNAL_REL, /nofollow/);
  assert.match(USER_EXTERNAL_REL, /ugc/);
});
