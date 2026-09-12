// SPDX-License-Identifier: MIT
// Winternitz OTS math. Byte-for-byte mirror of contracts/src/libs/HashSig.sol.
//
//   f(x,j)   = keccak256( 0x71 || j || x )           (j: one byte)
//   pk_j     = f^15(sk_j)
//   sig_j(d) = f^(15-d)(sk_j)
//   leaf     = keccak256( pk_0 || pk_1 || ... || pk_66 )
//   digits:  message digest nibbles (big-endian) + WOTS checksum in base 16.

import {
  CHAIN_DOMAIN,
  LEN,
  LEN1,
  LEN2,
  PUB_STEPS,
  RADIX,
} from "./constants.ts";
import { cat, keccak, u8 } from "./crypto.ts";
import type { Bytes } from "./crypto.ts";

function assertLen(b: Bytes, want: number, what: string) {
  if (b.length !== want) throw new Error(`${what}: got ${b.length}, want ${want}`);
}

/**
 * keccak input prefix for a chain step: 0x71 || j. Precomputed per j because
 * chainStep runs ~1M times per tree build (1024 leaves x 67 chains x 15 steps)
 * and `keccak(u8(CHAIN_DOMAIN), u8(j), x)` would allocate two one-byte arrays
 * and concatenate them on every one of those calls. Byte-identical to that
 * expression: cat(CHAIN_PREFIX[j], x) === u8(0x71) || u8(j) || x.
 */
const CHAIN_PREFIX: readonly Bytes[] = Array.from(
  { length: 256 },
  (_, j) => Uint8Array.of(CHAIN_DOMAIN & 0xff, j),
);

/** One chain application at position j. */
export function chainStep(x: Bytes, j: number): Bytes {
  assertLen(x, 32, "chainStep input");
  // j is always 0..LEN-1 (<= 66); `& 0xff` mirrors the byte truncation u8() did.
  return keccak(CHAIN_PREFIX[j & 0xff]!, x);
}

/** `steps` applications (0..PUB_STEPS); 0 steps is identity. */
export function chain(x: Bytes, j: number, steps: number): Bytes {
  if (steps < 0 || steps > PUB_STEPS) throw new Error(`chain steps out of range: ${steps}`);
  let out = x;
  for (let i = 0; i < steps; i++) out = chainStep(out, j);
  return out;
}

/** Public element pk_j = f^15(sk_j). */
export function publicElement(secret: Bytes, j: number): Bytes {
  return chain(secret, j, PUB_STEPS);
}

/** Signature element for digit d. */
export function signElement(secret: Bytes, j: number, d: number): Bytes {
  if (d < 0 || d >= RADIX) throw new Error(`bad digit ${d}`);
  return chain(secret, j, PUB_STEPS - d);
}

/** The 64 message nibbles of a 256-bit digest, MSB first (bytes[0] high nibble
 * first). Equivalent to (digest >> (252 - 4j)) & 0xF on a big-endian uint256. */
export function messageDigits(digest: Bytes): number[] {
  assertLen(digest, 32, "digest");
  const out: number[] = [];
  for (let j = 0; j < LEN1; j++) {
    const byteIdx = j >>> 1; // j >> 1
    const high = (j & 1) === 0;
    const byte = digest[byteIdx]!; // digest is asserted 32 bytes above
    out.push(high ? (byte >>> 4) & 0xf : byte & 0xf);
  }
  return out;
}

/** WOTS checksum over the message digits: sum_j (15 - d_j), base-16 MSB-first in
 * exactly LEN2 digits. */
export function checksumDigits(msgDigits: readonly number[]): number[] {
  if (msgDigits.length !== LEN1) throw new Error("checksum expects 64 message digits");
  let sum = 0;
  for (const d of msgDigits) sum += PUB_STEPS - d;
  if (sum >= 1 << (4 * LEN2)) throw new Error("checksum overflow (design bug)");
  const out: number[] = [];
  for (let i = 0; i < LEN2; i++) {
    const shift = 4 * (LEN2 - 1 - i);
    out.push((sum >> shift) & 0xf);
  }
  return out;
}

/** Full 67 digits (message then checksum). */
export function digitsOf(digest: Bytes): number[] {
  return [...messageDigits(digest), ...checksumDigits(messageDigits(digest))];
}

/** Reconstruct the leaf that a signature opens for `digest`: chain each WOTS
 * element forward by its digit, concatenate, hash. Equivalent to
 * HashSig.leafFromSignature. */
export function leafFromSignature(digest: Bytes, sig: Bytes[]): Bytes {
  if (sig.length !== LEN) throw new Error(`signature must have ${LEN} elements, got ${sig.length}`);
  const digits = digitsOf(digest);
  const parts: Bytes[] = [];
  for (let j = 0; j < LEN; j++) {
    // sig.length === LEN and digitsOf(digest) always returns LEN entries.
    parts.push(chain(sig[j]!, j, digits[j]!));
  }
  return keccak(cat(...parts));
}

/** Deterministic chain secret for (seed, leafIndex, chain j) — this is the ONLY
 * way seeds are turned into WOTS secrets, and must match TreeSigner.chainSecret
 * (keccak(seed || uint16(leafIndex) || uint8(j))). */
export function leafSecret(seed: Bytes, leafIndex: number, j: number): Bytes {
  assertLen(seed, 32, "seed");
  if (leafIndex < 0 || leafIndex >= (1 << 16)) throw new Error("leafIndex out of uint16 range");
  const b = new Uint8Array(2);
  b[0] = (leafIndex >>> 8) & 0xff;
  b[1] = leafIndex & 0xff;
  return keccak(seed, b, u8(j));
}

/** Public leaf for (seed, leafIndex): keccak of its 67 public elements. */
export function publicLeaf(seed: Bytes, leafIndex: number): Bytes {
  const parts: Bytes[] = [];
  for (let j = 0; j < LEN; j++) {
    parts.push(publicElement(leafSecret(seed, leafIndex, j), j));
  }
  return keccak(cat(...parts));
}
