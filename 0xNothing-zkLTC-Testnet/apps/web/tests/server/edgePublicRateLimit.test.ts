import assert from "node:assert/strict";
import test from "node:test";
import { publicApiRateLimitedResponse } from "../../lib/server/edgePublicRateLimit.ts";

function request(path: string, init?: RequestInit) {
  return new Request(`https://app.test${path}`, init);
}

function withEnv(overrides: Record<string, string | undefined>, run: () => void) {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(overrides)) {
    previous.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    run();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("unidentified clients are not collapsed into one public API quota", () => {
  withEnv({ VERCEL: undefined, CLOUDFLARE_WORKERS: undefined, TRUSTED_PROXY_SHARED_SECRET: undefined }, () => {
    for (let index = 0; index < 200; index += 1) {
      assert.equal(publicApiRateLimitedResponse(request("/api/pump/markets"), "/api/pump/markets"), null);
    }
  });
});

test("identified GET clients are limited and health stays exempt", () => {
  withEnv({ VERCEL: "1" }, () => {
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
  });
});

test("identified write clients share a tighter quota than reads", () => {
  withEnv({ VERCEL: "1" }, () => {
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
  });
});

test("Cloudflare Workers trust cf-connecting-ip without a proxy secret", () => {
  withEnv({
    VERCEL: undefined,
    CLOUDFLARE_WORKERS: "true",
    TRUSTED_PROXY_SHARED_SECRET: undefined,
  }, () => {
    const headers = { "cf-connecting-ip": "203.0.113.52" };
    let limited: Response | null = null;
    for (let index = 0; index < 181; index += 1) {
      limited = publicApiRateLimitedResponse(
        request("/api/pump/markets", { headers }),
        "/api/pump/markets",
      );
    }
    assert.ok(limited);
    assert.equal(limited.status, 429);
  });
});

test("Cloudflare Workers do not collapse visitors missing cf-connecting-ip", () => {
  withEnv({
    VERCEL: undefined,
    CLOUDFLARE_WORKERS: "true",
    TRUSTED_PROXY_SHARED_SECRET: undefined,
  }, () => {
    for (let index = 0; index < 200; index += 1) {
      assert.equal(publicApiRateLimitedResponse(request("/api/pump/markets"), "/api/pump/markets"), null);
    }
  });
});

test("Railway ignores spoofed Cloudflare IPs unless the proxy secret matches", () => {
  withEnv({
    VERCEL: undefined,
    CLOUDFLARE_WORKERS: undefined,
    TRUSTED_PROXY_SHARED_SECRET: undefined,
  }, () => {
    const headers = { "cf-connecting-ip": "203.0.113.53" };
    for (let index = 0; index < 200; index += 1) {
      assert.equal(
        publicApiRateLimitedResponse(request("/api/pump/markets", { headers }), "/api/pump/markets"),
        null,
      );
    }
  });

  withEnv({
    VERCEL: undefined,
    CLOUDFLARE_WORKERS: undefined,
    TRUSTED_PROXY_SHARED_SECRET: "test-only-cloudflare-origin-secret",
  }, () => {
    const headers = {
      "cf-connecting-ip": "203.0.113.54",
      "x-0xnothing-proxy-secret": "test-only-cloudflare-origin-secret",
    };
    let limited: Response | null = null;
    for (let index = 0; index < 181; index += 1) {
      limited = publicApiRateLimitedResponse(
        request("/api/pump/markets", { headers }),
        "/api/pump/markets",
      );
    }
    assert.ok(limited);
    assert.equal(limited.status, 429);
  });
});
