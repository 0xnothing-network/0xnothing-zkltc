import assert from "node:assert/strict";
import test from "node:test";
import { readLimitedBytes } from "../../lib/server/readLimitedBytes.ts";
import { createSlidingWindowRateLimiter } from "../../lib/server/slidingWindowRateLimit.ts";
import { evaluateModule } from "../helpers/evaluateModule.ts";

const address = `0x${"1".repeat(40)}`;
const contentHash = `0x${"2".repeat(64)}`;
const signature = `0x${"3".repeat(130)}`;

function harness() {
  const reservations: Array<(reserved: boolean) => void> = [];
  let uploads = 0;
  let pinStatus = 200;
  const route = evaluateModule<{ POST: (request: Request) => Promise<Response> }>(
    new URL("../../app/api/ipfs/upload/route.ts", import.meta.url),
    {
      "next/server": { NextResponse: Response },
      viem: { verifyMessage: async () => true },
      "@/features/pump/abis": { zeroXPumpAbi: [] },
      "@/features/pump/contentHash": { computePumpContentHash: async () => contentHash },
      "@/features/pump/imageValidation": { PUMP_MAX_IMAGE_BYTES: 2 * 1024 * 1024, validatePumpImage: async () => null },
      "@/features/pump/config": { PUMP_CHAIN_ID: 1, PUMP_CONFIGURED: true, PUMP_FACTORY_ADDRESS: address, isValidPumpExternalUrl: () => true },
      "@/features/pump/uploadMessage": {
        normalizePumpUploadMessage: (message: string) => message,
        parsePumpUploadMessage: () => ({ address, contentHash, domain: "app.test", chainId: 1, timestamp: new Date().toISOString() }),
      },
      "@/lib/contract": { publicClient: { readContract: () => new Promise<boolean>((resolve) => reservations.push(resolve)) } },
      "@/lib/server/clientIp": { trustedClientRateLimitKey: () => null, trustedProxyClientKey: () => "unknown" },
      "@/lib/server/readLimitedBytes": { readLimitedBytes },
      "@/lib/server/readLimitedJson": { readLimitedJson: (response: Response) => response.json() },
      "@/lib/server/slidingWindowRateLimit": { createSlidingWindowRateLimiter },
    },
    {
      Request, Response, FormData, File, Blob, URL, TextEncoder, AbortSignal,
      console: { error() {}, warn() {} },
      process: { env: { PINATA_JWT: "test-only", NODE_ENV: "production", UPLOAD_SIGNING_DOMAIN: "app.test" } },
      fetch: async () => { uploads += 1; return Response.json({ data: { cid: "bafytest" } }, { status: pinStatus }); },
    },
  );
  return {
    reservations,
    uploads: () => uploads,
    failPins: (fail: boolean) => { pinStatus = fail ? 503 : 200; },
    post() {
      const form = new FormData();
      form.set("file", new File(["test"], "logo.png", { type: "image/png" }));
      for (const [key, value] of Object.entries({ address, contentHash, signature, message: "signed upload", name: "Token", symbol: "TK" })) form.set(key, value);
      return route.POST(new Request("https://app.test/api/ipfs/upload", { method: "POST", body: form }));
    },
  };
}

async function waitForReservations(h: ReturnType<typeof harness>, count: number) {
  for (let attempt = 0; attempt < 100 && h.reservations.length < count; attempt += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.equal(h.reservations.length, count, "requests reached the RPC boundary");
}

test("a delayed duplicate authorization cannot upload again after the first request completes", async () => {
  const h = harness();
  const first = h.post();
  const duplicate = h.post();
  await waitForReservations(h, 2);
  h.reservations[0](true);
  assert.equal((await first).status, 201);
  h.reservations[1](true);
  assert.equal((await duplicate).status, 409);
  assert.equal(h.uploads(), 2, "only one image and one metadata document are pinned");
});

test("failed uploads release their reservation and allow a valid retry", async () => {
  const h = harness();
  h.failPins(true);
  const failed = h.post();
  await waitForReservations(h, 1);
  h.reservations[0](true);
  assert.equal((await failed).status, 502);
  h.failPins(false);
  const retry = h.post();
  await waitForReservations(h, 2);
  h.reservations[1](true);
  assert.equal((await retry).status, 201);
});
