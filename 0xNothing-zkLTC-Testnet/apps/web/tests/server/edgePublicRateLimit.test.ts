import assert from "node:assert/strict";
import test from "node:test";
import { publicApiRateLimitedResponse } from "../../lib/server/edgePublicRateLimit.ts";

function request(path: string, init?: RequestInit) {
  return new Request(`https://app.test${path}`, init);
}

test("unidentified clients are not collapsed into one public API quota", () => {
  const previous = process.env.VERCEL;
  delete process.env.VERCEL;
  try {
    for (let index = 0; index < 200; index += 1) {
      assert.equal(publicApiRateLimitedResponse(request("/api/pump/markets"), "/api/pump/markets"), null);
    }
  } finally {
    if (previous === undefined) delete process.env.VERCEL;
    else process.env.VERCEL = previous;
  }
});

test("identified GET clients are limited and health stays exempt", () => {
  const previous = process.env.VERCEL;
  process.env.VERCEL = "1";
  try {
    const headers = { "x-vercel-forwarded-for": "203.0.113.40" };
    assert.equal(publicApiRateLimitedResponse(request("/api/health", { headers }), "/api/health"), null);
    let limited: Response | null = null;
    for (let index = 0; index < 181; index += 1) {
      limited = publicApiRateLimitedResponse(
        request("/api/pump/markets", { headers }),
        "/api/pump/markets",
      );
    }
    assert.ok(limited);
    assert.equal(limited.status, 429);
    assert.equal(limited.headers.get("retry-after"), "60");
  } finally {
    if (previous === undefined) delete process.env.VERCEL;
    else process.env.VERCEL = previous;
  }
});

test("identified write clients share a tighter quota than reads", () => {
  const previous = process.env.VERCEL;
  process.env.VERCEL = "1";
  try {
    const headers = { "x-vercel-forwarded-for": "203.0.113.41" };
    let limited: Response | null = null;
    for (let index = 0; index < 31; index += 1) {
      limited = publicApiRateLimitedResponse(
        request("/api/ipfs/upload", { method: "POST", headers }),
        "/api/ipfs/upload",
      );
    }
    assert.ok(limited);
    assert.equal(limited.status, 429);
  } finally {
    if (previous === undefined) delete process.env.VERCEL;
    else process.env.VERCEL = previous;
  }
});
