// SPDX-License-Identifier: MIT
// Icon-codec: a high-entropy, human-retypable representation of the 256-bit
// wallet secret. 24 symbols drawn from a fixed 2048-glyph alphabet (11 bits per
// symbol) encode the 256-bit entropy plus an 8-bit sha256 checksum — exactly the
// BIP-39 construction, generalized to icons.
//
// The alphabet is built deterministically from curated Unicode ranges and keeps
// only NFKC-stable single code points, so copy/paste and decomposed input both
// decode to the same secret. NFKC normalization is applied before decoding.
//
// The icons themselves NEVER leave the user's device and NEVER authorize an
// on-chain action directly (that would reveal them). They are the entropy seed
// from which signing trees and vault keys are derived offline.

import { sha256 } from "./crypto.ts";

export const ENTROPY_BYTES = 32; // 256 bits
export const SYMBOL_BITS = 11; // log2(2048)
export const ALPHABET_SIZE = 1 << SYMBOL_BITS; // 2048
export const SYMBOL_COUNT = 24; // (256 + 8) / 11

// Candidate Unicode ranges, scanned ascending. Everything else is derived.
const RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x0021, 0x007e], // Basic Latin (printable)
  [0x00a1, 0x00ff], // Latin-1 Supplement (printable)
  [0x0100, 0x017f], // Latin Extended-A
  [0x0180, 0x024f], // Latin Extended-B
  [0x0370, 0x03ff], // Greek and Coptic
  [0x0400, 0x04ff], // Cyrillic
  [0x1e00, 0x1eff], // Latin Extended Additional
  [0x1f00, 0x1fff], // Greek Extended
  [0x2190, 0x21ff], // Arrows
  [0x2200, 0x22ff], // Mathematical Operators
  [0x2300, 0x23ff], // Miscellaneous Technical
  [0x2500, 0x257f], // Box Drawing
  [0x2580, 0x259f], // Block Elements
  [0x25a0, 0x25ff], // Geometric Shapes
  [0x2600, 0x26ff], // Miscellaneous Symbols
  [0x2700, 0x27bf], // Dingbats
  [0x27c0, 0x27ef], // Miscellaneous Mathematical Symbols-A
  [0x2b00, 0x2bff], // Miscellaneous Symbols and Arrows
  [0x2e00, 0x2e7f], // Supplemental Punctuation
  [0x2800, 0x28ff], // Braille Patterns (spare fill; 0x2800 blank excluded below)
  [0x3040, 0x30ff], // Hiragana + Katakana (spare fill)
  [0x3001, 0x303f], // CJK Symbols and Punctuation (spare fill; 0x3000 space excluded)
];

const EXCLUDE = new Set<number>([
  0x00ad, // soft hyphen (invisible)
  0x00a0, // nbsp
  0x2800, // braille blank (invisible)
  0x3000, // ideographic space (defense; also dropped by /\s/)
  0x3004, // unassigned hole in CJK Symbols block
  0x3020, // unassigned hole in CJK Symbols block
  0x302a, 0x302b, 0x302c, 0x302d, 0x302e, 0x302f, // CJK combining strokes (attach to neighbors)
  0x3040, // unassigned hole before Hiragana
  0x3097, 0x3098, // unassigned holes in Hiragana
  0xfeff, // zero-width no-break space (defense; not in ranges anyway)
]);

/** Deterministic NFKC-stable 2048-glyph alphabet (single BMP code points). */
function buildAlphabet(): string[] {
  const out: string[] = [];
  outer: for (const [lo, hi] of RANGES) {
    for (let cp = lo; cp <= hi; cp++) {
      if (EXCLUDE.has(cp)) continue;
      const ch = String.fromCodePoint(cp);
      if (/\s/.test(ch)) continue; // no spaces / line separators
      const nfkc = ch.normalize("NFKC");
      // Only keep code points that are their own NFKC form and single — this
      // drops compatibility characters that would collide (µ -> μ, ligatures,
      // circled digits, …) and keeps the alphabet stable under normalization.
      if (nfkc.length !== 1 || nfkc !== ch) continue;
      out.push(ch);
      if (out.length === ALPHABET_SIZE) break outer;
    }
  }
  if (out.length !== ALPHABET_SIZE) {
    throw new Error(`alphabet build produced ${out.length}, expected ${ALPHABET_SIZE}`);
  }
  return out;
}

const ALPHABET: string[] = buildAlphabet();
const INDEX: Map<string, number> = new Map(ALPHABET.map((ch, i) => [ch, i]));

export function alphabet(): ReadonlyArray<string> {
  return ALPHABET;
}

function bytesToBigInt(b: Uint8Array): bigint {
  let v = 0n;
  for (const x of b) v = (v << 8n) | BigInt(x);
  return v;
}

function bigIntToBytes(v: bigint, length: number): Uint8Array {
  const out = new Uint8Array(length);
  for (let i = length - 1; i >= 0; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

/** 24 symbols for a 32-byte secret (with checksum). */
export async function encodeSecret(entropy: Uint8Array): Promise<string> {
  if (entropy.length !== ENTROPY_BYTES) throw new Error("entropy must be 32 bytes");
  const hash = await sha256(entropy);
  // 264-bit value = entropy(256) || checksum(8)
  const bits = (bytesToBigInt(entropy) << 8n) | BigInt(hash[0]!); // sha256 => 32 bytes
  let out = "";
  for (let i = 0; i < SYMBOL_COUNT; i++) {
    const shift = BigInt(SYMBOL_BITS * (SYMBOL_COUNT - 1 - i));
    const idx = Number((bits >> shift) & 0x7ffn);
    out += ALPHABET[idx]!; // idx < ALPHABET_SIZE by construction
  }
  return out;
}

export interface DecodeResult {
  entropy: Uint8Array;
  valid: boolean;
  /** Index of the first offending symbol when invalid, else -1. */
  errorAt: number;
}

/** Decode icons back to the 32-byte secret, verifying the checksum. */
export async function decodeSecret(icons: string): Promise<DecodeResult> {
  const chars = Array.from(icons.normalize("NFKC"));
  if (chars.length !== SYMBOL_COUNT) {
    return { entropy: new Uint8Array(0), valid: false, errorAt: 0 };
  }
  let bits = 0n;
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i]!; // length checked above
    const idx = INDEX.get(ch);
    if (idx === undefined) return { entropy: new Uint8Array(0), valid: false, errorAt: i };
    bits = (bits << 11n) | BigInt(idx);
  }
  // 264 bits -> 33 bytes; last byte is the checksum.
  const raw = bigIntToBytes(bits, 33);
  const entropy = raw.slice(0, 32);
  const hash = await sha256(entropy);
  if (hash[0] !== raw[32]) return { entropy, valid: false, errorAt: -1 };
  return { entropy, valid: true, errorAt: -1 };
}

/** CSPRNG 32 bytes (WebCrypto / Node). */
export function randomEntropy(): Uint8Array {
  const out = new Uint8Array(ENTROPY_BYTES);
  crypto.getRandomValues(out);
  return out;
}

/** Convenience: make a fresh secret + its icon string. */
export async function generateSecret(): Promise<{ entropy: Uint8Array; icons: string }> {
  const entropy = randomEntropy();
  return { entropy, icons: await encodeSecret(entropy) };
}
