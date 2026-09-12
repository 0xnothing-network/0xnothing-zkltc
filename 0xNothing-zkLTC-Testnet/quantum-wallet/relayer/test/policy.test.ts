// SPDX-License-Identifier: MIT
// Pure-policy tests: shape validation matrix. No chain, no sponsor key — these
// run anywhere. The on-chain half of the relayer is exercised by e2e.ts against
// anvil + forge-deployed contracts (see ../README.md).

import assert from "node:assert/strict";
import test from "node:test";
import { validateRequest, LEN, TREE_H } from "../src/policy.ts";
import { OP_NO_EXPIRY } from "../../sdk/src/wallet.ts";

const CFG = {
  chainId: 4441,
  maxCallsPerOp: 16,
  maxCalldataBytesPerOp: 100_000,
  validUntilMaxSkewSec: 3_600,
};

const WALLET = "0x1111111111111111111111111111111111111111";
const FACTORY = "0x2222222222222222222222222222222222222222";
const ROOT0 = "0x" + "33".repeat(32);
const ROOT1 = "0x" + "44".repeat(32);

const wots = Array.from({ length: LEN }, (_, i) => "0x" + (i + 1).toString(16).padStart(64, "0"));
const path = Array.from({ length: TREE_H }, () => "0x" + "ab".repeat(32));
const sig = { epoch: 0, leafIndex: 0, wots, path };

function validExecute(over: Record<string, unknown> = {}) {
  const now = Math.floor(Date.now() / 1000);
  return {
    kind: "execute",
    wallet: WALLET,
    chainId: CFG.chainId,
    op: {
      walletNonce: "0",
      validUntil: String(now + 300),
      calls: [{ to: "0x3333333333333333333333333333333333333333", value: "1", data: "0x" }],
    },
    sig,
    ...over,
  };
}

test("valid execute passes", () => {
  assert.equal(validateRequest(validExecute(), CFG), null);
});

test("kind whitelist", () => {
  assert.match(validateRequest({ ...validExecute(), kind: "explode" }, CFG)!, /unknown kind/);
});

test("chainId binding", () => {
  assert.match(validateRequest({ ...validExecute(), chainId: 31337 }, CFG)!, /chainId mismatch/);
  assert.equal(validateRequest({ ...validExecute(), chainId: 4441 }, CFG), null);
});

test("bad wallet/root0/sig shapes", () => {
  assert.match(validateRequest({ ...validExecute(), wallet: "nope" }, CFG)!, /wallet/);
  const dep = { kind: "deploy", wallet: WALLET, chainId: CFG.chainId, root0: "0x1234" };
  assert.match(validateRequest(dep, CFG)!, /root0/);
  const dep2 = { ...dep, root0: ROOT0 };
  assert.equal(validateRequest(dep2, CFG), null);

  assert.match(validateRequest({ ...validExecute(), sig: { ...sig, wots: wots.slice(0, 5) } }, CFG)!, /wots/);
  assert.match(validateRequest({ ...validExecute(), sig: { ...sig, path: [] } }, CFG)!, /path/);
  assert.match(
    validateRequest({ ...validExecute(), sig: { ...sig, wots: wots.map(() => "0x1234") } }, CFG)!,
    /wots/,
  );
});

test("op batch caps", () => {
  const many = Array.from({ length: 17 }, () => ({
    to: "0x3333333333333333333333333333333333333333",
    value: "0",
    data: "0x",
  }));
  assert.match(validateRequest(validExecute({ op: { ...validExecute().op, calls: many } }), CFG)!, /calls/);
  assert.match(validateRequest(validExecute({ op: { ...validExecute().op, calls: [] } }), CFG)!, /calls/);

  // 100_001 bytes of calldata > maxCalldataBytesPerOp (100_000).
  const big = "0x" + "00".repeat(100_001);
  assert.match(
    validateRequest(
      validExecute({ op: { ...validExecute().op, calls: [{ to: WALLET, value: "0", data: big }] } }),
      CFG,
    )!,
    /calldata too large/,
  );
});

test("validUntil window", () => {
  const now = Math.floor(Date.now() / 1000);
  assert.match(
    validateRequest(validExecute({ op: { ...validExecute().op, validUntil: String(now + 99_999) } }), CFG)!,
    /future/,
  );
  assert.match(
    validateRequest(validExecute({ op: { ...validExecute().op, validUntil: String(now - 200_000) } }), CFG)!,
    /expired/,
  );
});

test("OP_NO_EXPIRY is accepted", () => {
  // Regression: QuantumAccount stamps every op with this sentinel, so if the
  // policy rejects it the wallet cannot send at all — and because the digest
  // commits to validUntil, the client cannot work around it by re-signing.
  assert.equal(OP_NO_EXPIRY, 0xffffffffn, "sentinel must stay 0xffffffff");
  assert.equal(
    validateRequest(validExecute({ op: { ...validExecute().op, validUntil: OP_NO_EXPIRY.toString() } }), CFG),
    null,
  );
  // The sentinel is exempt by exact value, not by being "large" — a value one
  // above/below it is still held to the skew window.
  assert.match(
    validateRequest(validExecute({ op: { ...validExecute().op, validUntil: String(OP_NO_EXPIRY - 1n) } }), CFG)!,
    /future/,
  );
  // Out of double range must be rejected, not silently rounded into a skew.
  assert.match(
    validateRequest(validExecute({ op: { ...validExecute().op, validUntil: "9".repeat(30) } }), CFG)!,
    /out of range/,
  );
});

test("nonce/value must be decimal strings", () => {
  assert.match(
    validateRequest(validExecute({ op: { ...validExecute().op, walletNonce: "0x1" } }), CFG)!,
    /nonce|walletNonce/,
  );
  assert.match(
    validateRequest(
      validExecute({
        op: { ...validExecute().op, calls: [{ to: WALLET, value: "1.5", data: "0x" }] },
      }),
      CFG,
    )!,
    /value/,
  );
});

test("rotate and signMessage validate their own fields", () => {
  const rot = { kind: "rotate", wallet: WALLET, chainId: CFG.chainId, newRoot: ROOT1, nextEpoch: 1, sig };
  assert.equal(validateRequest(rot, CFG), null);
  assert.match(validateRequest({ ...rot, newRoot: "0xzz" }, CFG)!, /newRoot/);
  assert.match(validateRequest({ ...rot, nextEpoch: -1 }, CFG)!, /nextEpoch/);

  const sm = { kind: "signMessage", wallet: WALLET, chainId: CFG.chainId, messageHash: ROOT0, sig };
  assert.equal(validateRequest(sm, CFG), null);
  assert.match(validateRequest({ ...sm, messageHash: "0x" }, CFG)!, /messageHash/);
});

test("the last leaf is reserved for rotation", () => {
  // QuantumWallet.RESERVED_ROTATE_LEAVES = 1: executeSigned reverts TreeExhausted
  // at leaf 1023, so relaying that op only wastes sponsor gas. rotateRoot is
  // allowed to spend it — that is the whole reason it is held back.
  const EXEC_MAX = 1023 - 1;

  assert.equal(
    validateRequest(validExecute({ sig: { ...sig, leafIndex: EXEC_MAX } }), CFG),
    null,
    `execute at the highest usable leaf (${EXEC_MAX}) must pass`,
  );
  assert.match(
    validateRequest(validExecute({ sig: { ...sig, leafIndex: EXEC_MAX + 1 } }), CFG)!,
    /limit/,
    "execute on the reserved leaf must be refused before it costs the sponsor gas",
  );
  assert.match(
    validateRequest(validExecute({ sig: { ...sig, leafIndex: 1024 } }), CFG)!,
    /limit/,
  );

  const rot = { kind: "rotate", wallet: WALLET, chainId: CFG.chainId, newRoot: ROOT1, nextEpoch: 1 };
  assert.equal(
    validateRequest({ ...rot, sig: { ...sig, leafIndex: EXEC_MAX + 1 } }, CFG),
    null,
    "rotation must still be able to consume the reserved leaf",
  );
  assert.match(
    validateRequest({ ...rot, sig: { ...sig, leafIndex: 1024 } }, CFG)!,
    /limit/,
    "even rotation cannot exceed the tree",
  );

  const sm = { kind: "signMessage", wallet: WALLET, chainId: CFG.chainId, messageHash: ROOT0 };
  assert.match(
    validateRequest({ ...sm, sig: { ...sig, leafIndex: EXEC_MAX + 1 } }, CFG)!,
    /limit/,
    "signMessage shares executeSigned's leaf bound",
  );
});
