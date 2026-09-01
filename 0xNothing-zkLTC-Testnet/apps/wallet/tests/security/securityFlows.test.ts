import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

function source(path: string): string {
  return readFileSync(new URL(path, import.meta.url), "utf8");
}

const approve = source("../../src/ui/screens/Approve.tsx");
const background = source("../../src/extension/background.ts");
const dapp = source("../../src/core/services/dapp.ts");
const send = source("../../src/ui/screens/Send.tsx");
const mint = source("../../src/ui/screens/MintNusd.tsx");
const sendNft = source("../../src/ui/screens/send/SendNft.tsx");
const swap = source("../../src/ui/screens/Swap.tsx");
const dapps = source("../../src/ui/screens/Dapps.tsx");
const settings = source("../../src/ui/screens/Settings.tsx");
const revealSecrets = source("../../src/ui/screens/settings/RevealSecrets.tsx");

test("every wallet-initiated transfer path requires an explicit review", () => {
  assert.match(send, /<TransactionReview/u);
  assert.match(mint, /<TransactionReview/u);
  assert.match(sendNft, /<TransactionReview/u);
  assert.match(swap, /setReviewRoute\(route\)/u);
  assert.match(swap, /route: reviewRoute/u);
});

test("dapp approvals fail closed after account or network context changes", () => {
  assert.match(approve, /signer === null \|\| mismatch \|\| networkMismatch/u);
  assert.match(approve, /mismatch \|\| networkMismatch \|\| unreadable/u);
  assert.match(approve, /claimPendingRequest\(request\.id\)/u);
  assert.match(approve, /resolveRequest\(request\.id, result, approvalClaim\)/u);
  assert.match(background, /kind: "switch-network"/u);
  assert.match(background, /targetNetworkId: target\.id/u);
});

test("extension-only events are authenticated and consumed signatures are removed", () => {
  assert.match(background, /isWalletUiSender\(sender\)/u);
  assert.match(background, /PROVIDER_EVENTS\.has\(request\.name\)/u);
  assert.match(dapp, /consumeResolution\(id\)/u);
  assert.match(background, /session\.setAccessLevel\(\{ accessLevel: "TRUSTED_CONTEXTS" \}\)/u);
});

test("the dapp RPC bridge bounds both request and streamed response bodies", () => {
  assert.match(background, /isBoundedRpcCall\(request\.call\)/u);
  assert.match(background, /providerIngress\.tryAcquire\(origin\)/u);
  assert.match(background, /sender\.id !== chrome\.runtime\.id/u);
  assert.match(background, /MAX_RPC_REQUEST_LENGTH/u);
  assert.match(background, /MAX_RPC_RESPONSE_BYTES/u);
  assert.match(background, /response\.body\.getReader\(\)/u);
  assert.match(background, /reader\.cancel\(\)/u);
});

test("swap catalog refresh pauses with the hidden wallet", () => {
  assert.doesNotMatch(swap, /setInterval\(/u);
  assert.match(swap, /document\.hidden/u);
  assert.match(swap, /visibilitychange/u);
});

test("the DApp permission list follows writes from every wallet surface", () => {
  assert.match(dapps, /persistentStore\.subscribe\(/u);
  assert.match(dapps, /STORAGE_KEYS\.connections/u);
  assert.match(dapps, /read\.reload\(\)/u);
});

test("custom RPC permissions are rechecked and cleaned up from settings", () => {
  assert.match(settings, /requestRpcPermission\(selected\.rpcUrl\)/u);
  assert.match(settings, /if \(!usedBySavedProfile\) await releaseRpcPermission/u);
  assert.match(settings, /releaseRpcPermission\(removed\.rpcUrl\)/u);
  assert.match(settings, /nativeDecimals: event\.target\.value/u);
});

test("clipboard failures are visible even on the secret-reveal surface", () => {
  assert.match(revealSecrets, /copy\(secret\)\.then/u);
  assert.match(revealSecrets, /common\.copyFailed/u);
});
