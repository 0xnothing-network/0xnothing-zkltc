import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { evaluateModule } from "../helpers/evaluateModule.ts";
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

test("NFT metadata and images come only from the IPFS and Arweave gateways", () => {
  const { metadataFetchUrl, validatedErc721MetadataFromJson } = evaluateModule<{
    metadataFetchUrl(value: string): string | null;
    validatedErc721MetadataFromJson(json: Record<string, unknown>, collection: string, tokenId: string): { imageUrl: string } | null;
  }>(
    new URL("../../lib/erc721Metadata.server.ts", import.meta.url),
    {
      "server-only": {},
      viem: { createPublicClient: () => ({}), getAddress: (value: string) => value },
      "@/lib/rpcTransport": { litvmTransport: () => ({}) },
      "@/config/wagmi": { litvm: {} },
      "@/lib/nftKey": { marketplaceNftKey: () => "" },
      "@/lib/boundedCache": { createBoundedCache: () => ({}) },
      "@/lib/server/readLimitedBytes": { readLimitedBytes: async () => new Uint8Array() },
      "@/lib/tokenId": { normalizeUint256TokenId: (value: string) => value },
    },
    { URL, Buffer },
  );
  assert.equal(metadataFetchUrl("ipfs://bafy/1.json"), "https://ipfs.io/ipfs/bafy/1.json");
  assert.equal(metadataFetchUrl("ar://tx/1"), "https://arweave.net/tx/1");
  assert.equal(
    metadataFetchUrl("https://gateway.example.org/ipfs/bafy/1.json?v=2"),
    "https://ipfs.io/ipfs/bafy/1.json?v=2",
  );
  for (const uri of [
    "https://metadata.example.org/1",
    "https://rebind.example.org/latest/meta-data/",
    "http://ipfs.io/ipfs/bafy",
    "https://user:pass@ipfs.io/ipfs/bafy",
  ]) {
    assert.equal(metadataFetchUrl(uri), null, uri);
  }
  const image = (value: string) => validatedErc721MetadataFromJson({ image: value }, "0xc", "1")?.imageUrl ?? null;
  assert.equal(image("ipfs://bafy/1.png"), "https://ipfs.io/ipfs/bafy/1.png");
  assert.equal(image("data:image/png;base64,AAAA"), "data:image/png;base64,AAAA");
  assert.equal(image("https://tracker.example.org/pixel.png"), null);
});

test("server-side upstream JSON consumers retain explicit byte limits", () => {
  for (const path of [
    "../../app/api/ipfs/upload/route.ts",
    "../../features/fi/lib/server/goldsky.ts",
    "../../features/pump/server/graph.ts",
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

test("token lookups rate-limit a trusted client identity, never one shared bucket", () => {
  const source = readFileSync(
    new URL("../../app/0xFi/api/token/[address]/route.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /trustedClientRateLimitKey\(trustedClientKey\(request\)\)/u);
  assert.match(source, /if \(key === null\) return \{ allowed: true \};/u);
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
