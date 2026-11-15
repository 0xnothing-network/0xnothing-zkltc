import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { claimReviewReady } from "../../src/ui/lib/claimReview.ts";
import { reviewKey } from "../../src/ui/lib/reviewKey.ts";

const ACCOUNT = "0x0000000000000000000000000000000000000001";
const identity = reviewKey([ACCOUNT, "litvm-4441", "https://rpc.example/", "claim"]);
const reviewed = { identity, amount: 10n };

test("a claim review stays armed while rewards keep streaming", () => {
  assert.equal(claimReviewReady(reviewed, { identity, claimable: 10n }), true);
  assert.equal(claimReviewReady(reviewed, { identity, claimable: 11n }), true);
});

test("a claim review disarms when the claimable shrinks, is zero or unread", () => {
  assert.equal(claimReviewReady(reviewed, { identity, claimable: 9n }), false);
  assert.equal(claimReviewReady(reviewed, { identity, claimable: 0n }), false);
  assert.equal(claimReviewReady(reviewed, { identity, claimable: null }), false);
  assert.equal(claimReviewReady({ identity, amount: 0n }, { identity, claimable: 0n }), false);
});

test("a claim review disarms when the account or network changes", () => {
  const otherAccount = reviewKey(["0x0000000000000000000000000000000000000002", "litvm-4441", "https://rpc.example/", "claim"]);
  const otherRpc = reviewKey([ACCOUNT, "litvm-4441", "https://other.example/", "claim"]);
  assert.equal(claimReviewReady(reviewed, { identity: otherAccount, claimable: 20n }), false);
  assert.equal(claimReviewReady(reviewed, { identity: otherRpc, claimable: 20n }), false);
});

test("Earn keeps the streaming claimable out of the claim identity", () => {
  const source = readFileSync(new URL("../../src/ui/screens/Earn.tsx", import.meta.url), "utf8");
  assert.match(source, /const claimIdentity = reviewKey\(\[address, network\.id, network\.rpcUrl, "claim"\]\);/u);
  assert.match(source, /claimReviewReady\(review,/u);
  assert.match(source, /t\("earn\.claimAtLeast"/u);
});
