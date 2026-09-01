import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { isUnsafeRemoteHostname } from "../../lib/server/networkAddress.ts";
import {
  PublicRouteError,
  publicErrorMessage,
} from "../../lib/server/publicError.ts";

test("publicErrorMessage redacts arbitrary upstream details", () => {
  const secret = new Error("request to https://user:secret@example.test failed");
  assert.equal(publicErrorMessage(secret, "Upstream unavailable"), "Upstream unavailable");
  assert.equal(
    publicErrorMessage(new PublicRouteError("Unsupported pair."), "Upstream unavailable"),
    "Unsupported pair.",
  );
});

test("metadata hostname policy rejects local names and every IP literal", () => {
  for (const hostname of [
    "localhost",
    "intranet",
    "service.internal.",
    "router.home.arpa",
    "127.0.0.1",
    "203.0.113.8",
    "[::1]",
    "[::ffff:7f00:1]",
  ]) {
    assert.equal(isUnsafeRemoteHostname(hostname), true, hostname);
  }
  assert.equal(isUnsafeRemoteHostname("metadata.example.org"), false);
});

test("server-side upstream JSON consumers retain explicit byte limits", () => {
  for (const path of [
    "../../app/api/ipfs/upload/route.ts",
    "../../features/fi/lib/server/goldsky.ts",
    "../../features/pump/server/graph.ts",
    "../../lib/marketplaceSubgraph.ts",
    "../../lib/onchainMarketplace.ts",
  ]) {
    const source = readFileSync(new URL(path, import.meta.url), "utf8");
    assert.match(source, /readLimitedJson/u, path);
    assert.doesNotMatch(source, /response\.json\s*\(/u, path);
  }
});

test("upload admission adds an IP quota only for a trusted client key", () => {
  const source = readFileSync(
    new URL("../../app/api/ipfs/upload/route.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /trustedClientRateLimitKey\(ip\)/u);
  assert.doesNotMatch(source, /`ip:\$\{ip\}`/u);
});

test("public API failures do not return arbitrary upstream error messages", () => {
  for (const path of [
    "../../app/0xFi/api/data/activity/route.ts",
    "../../app/0xFi/api/data/candles/route.ts",
    "../../app/0xFi/api/data/pools/route.ts",
    "../../app/api/pixel-image/route.ts",
    "../../app/api/token-metadata/route.ts",
    "../../app/api/user-nfts/route.ts",
  ]) {
    const source = readFileSync(new URL(path, import.meta.url), "utf8");
    assert.doesNotMatch(source, /error:\s*\([^)]*Error\)\.message/u, path);
    assert.doesNotMatch(source, /\$\{error instanceof Error \? error\.message/u, path);
  }
});
