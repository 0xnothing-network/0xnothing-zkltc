import assert from "node:assert/strict";
import test from "node:test";
import { buildPumpUploadMessage, parsePumpUploadMessage } from "../../features/pump/uploadMessage.ts";

const fields = {
  address: `0x${"1".repeat(40)}`,
  chainId: 4441,
  contentHash: `0x${"2".repeat(64)}`,
  nonce: "abcdefghijklmnop",
  timestamp: "2026-11-01T00:00:00.000Z",
} as const;

test("a signed upload names a host-shaped domain or does not parse", () => {
  for (const domain of ["www.0xnothing.xyz", "localhost:3300", "[::1]:3300"]) {
    assert.equal(parsePumpUploadMessage(buildPumpUploadMessage({ ...fields, domain }))?.domain, domain);
  }
  for (const domain of ["", "evil host", "\u001b[31mred", "a".repeat(256)]) {
    assert.equal(parsePumpUploadMessage(buildPumpUploadMessage({ ...fields, domain })), null, JSON.stringify(domain));
  }
});
