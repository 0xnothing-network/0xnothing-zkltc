// SPDX-License-Identifier: MIT
// Core math tests: WOTS identities, Merkle path proofs, signer determinism and
// signature/leaf agreement — the same properties the Solidity suite checks, in TS.

import assert from "node:assert/strict";
import test from "node:test";
import { LEN, LEN1, PUB_STEPS, TREE_N } from "../src/constants.ts";
import {
  chain,
  chainStep,
  checksumDigits,
  digitsOf,
  leafFromSignature,
  leafSecret,
  messageDigits,
  publicElement,
  publicLeaf,
  signElement,
} from "../src/wots.ts";
import { authPath, buildLevels, computeRoot } from "../src/merkle.ts";
import { QuantumSigner } from "../src/signer.ts";
import { keccak } from "../src/crypto.ts";

const SEED = new Uint8Array(32).fill(0xab);
const DIGEST = keccak(new TextEncoder().encode("0xNothing test digest"));

test("chain() equals repeated chainStep(), and pubkey = 15 steps", () => {
  const sk = new Uint8Array(32).fill(9);
  const manual = (() => {
    let x = sk;
    for (let i = 0; i < PUB_STEPS; i++) x = chainStep(x, 3);
    return x;
  })();
  assert.deepEqual(Buffer.from(publicElement(sk, 3)), Buffer.from(manual));
  assert.deepEqual(Buffer.from(publicElement(sk, 3)), Buffer.from(chain(sk, 3, PUB_STEPS)));
  assert.throws(() => chain(sk, 3, PUB_STEPS + 1));
});

test("signElement then forward chain by digit recovers the public element", () => {
  const sk = new Uint8Array(32).fill(0x5c);
  for (let j = 0; j < 5; j++) {
    for (let d = 0; d <= 15; d++) {
      const sig = signElement(sk, j, d);
      const recovered = chain(sig, j, d);
      assert.deepEqual(Buffer.from(recovered), Buffer.from(publicElement(sk, j)));
    }
  }
});

test("digits: 64 message nibbles + 3 checksum nibbles = 67", () => {
  const ds = digitsOf(DIGEST);
  assert.equal(ds.length, LEN);
  const md = messageDigits(DIGEST);
  assert.equal(md.length, LEN1);
  assert.deepEqual(checksumDigits(md), ds.slice(LEN1));
  // nibble extraction is big-endian: byte0 high nibble is first
  assert.equal(md[0], DIGEST[0] >> 4);
  assert.equal(md[1], DIGEST[0] & 0xf);
  assert.equal(md[62], DIGEST[31] >> 4);
  assert.equal(md[63], DIGEST[31] & 0xf);
});

test("signature opens exactly the committed leaf", () => {
  const signer = new QuantumSigner(SEED);
  // Signing needs the tree; build once (slow ~1M hashes).
  const s = signer.signNext(DIGEST);
  assert.equal(s.leafIndex, 0);
  const leaf = leafFromSignature(DIGEST, s.wots);
  assert.deepEqual(Buffer.from(leaf), Buffer.from(publicLeaf(SEED, 0)), "leaf == committed pk");
  assert.deepEqual(
    Buffer.from(signer.root),
    Buffer.from(computeRoot(leaf, 0, s.path)),
    "path proves leaf to root",
  );
});

test("auth path proves every leaf index", () => {
  const signer = new QuantumSigner(SEED);
  for (const idx of [0, 1, 2, 3, 127, 511, 512, 1023]) {
    const leaf = publicLeaf(SEED, idx);
    const path = authPath(signer["tree"].levels as never, idx);
    assert.deepEqual(Buffer.from(computeRoot(leaf, idx, path)), Buffer.from(signer.root));
    // tamper one element -> root mismatch
    const p2 = path.slice();
    p2[4] = keccak(new Uint8Array(32));
    assert.notDeepEqual(Buffer.from(computeRoot(leaf, idx, p2)), Buffer.from(signer.root));
  }
});

test("signing two digests must consume two distinct leaves", () => {
  const signer = new QuantumSigner(SEED);
  const a = signer.signNext(DIGEST);
  const b = signer.signNext(keccak(new Uint8Array(32)));
  assert.equal(a.leafIndex, 0);
  assert.equal(b.leafIndex, 1);
  assert.equal(signer.leafCursor, 2);
});

test("leafSecret is deterministic per (seed, index, chain)", () => {
  assert.deepEqual(Buffer.from(leafSecret(SEED, 5, 9)), Buffer.from(leafSecret(SEED, 5, 9)));
  assert.notDeepEqual(Buffer.from(leafSecret(SEED, 5, 9)), Buffer.from(leafSecret(SEED, 6, 9)));
  assert.notDeepEqual(Buffer.from(leafSecret(SEED, 5, 9)), Buffer.from(leafSecret(SEED, 5, 10)));
});

test("signature binds the digest (tamper changes the leaf)", () => {
  const signer = new QuantumSigner(SEED);
  const s = signer.signNext(DIGEST);
  const tampered = keccak(new TextEncoder().encode("tampered"));
  const otherLeaf = leafFromSignature(tampered, s.wots);
  assert.notDeepEqual(Buffer.from(otherLeaf), Buffer.from(publicLeaf(SEED, 0)));
});

test("tree exhausts at TREE_N and demands rotation", () => {
  const signer = new QuantumSigner(SEED);
  // Can't walk 1024 signatures in a test budget — assert the guard math.
  signer.leafCursor = TREE_N;
  assert.throws(() => signer.signNext(DIGEST), /rotate root/);
});
