import assert from "node:assert/strict";
import { test } from "node:test";
import { typedSummary } from "../../src/ui/lib/typedData.ts";

test("typed-data approval renders only validated text and chain identifiers", () => {
  for (const chainId of [4441, "4441", "0x1159"]) {
    assert.deepEqual(typedSummary(JSON.stringify({
      domain: { name: "Example", chainId },
      primaryType: "Permit",
    })), { domain: "Example", primaryType: "Permit", chainId: 4441 });
  }
  assert.deepEqual(typedSummary("{}"), { domain: "—", primaryType: "—", chainId: null });
});

test("malformed dapp display fields fail closed instead of crashing the approval screen", () => {
  for (const payload of [
    null, [], "payload", 42,
    { domain: null }, { domain: [] },
    { domain: { name: { hostile: "object" } } },
    { domain: { name: ["nested", { hostile: true }] } },
    { primaryType: { hostile: "object" } },
    { primaryType: ["Permit"] },
    ...[null, true, {}, [], "", " ", "1e3", "NaN", "Infinity", "-1", 1.5, -1,
      "9007199254740992"].map((chainId) => ({ domain: { chainId } })),
  ]) {
    assert.equal(typedSummary(JSON.stringify(payload)), null, JSON.stringify(payload));
  }
  assert.equal(typedSummary("{"), null);
});
