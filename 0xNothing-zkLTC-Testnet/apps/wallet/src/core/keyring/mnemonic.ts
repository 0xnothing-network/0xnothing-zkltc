import { english, generateMnemonic } from "viem/accounts";

/**
 * BIP-39 helpers.
 *
 * viem re-exports `generateMnemonic` and the wordlists but not a validator, and
 * @scure/bip39's `mnemonicToSeedSync` derives a seed from *any* word sequence —
 * it never checks the checksum. A wallet that silently accepts a mistyped
 * phrase would hand the user an empty account and call it restored, so the
 * checksum is verified here before a phrase is ever accepted.
 */

const WORDLIST = english;
const WORD_INDEX = new Map(WORDLIST.map((word, index) => [word, index]));
const VALID_LENGTHS = new Set([12, 15, 18, 21, 24]);

export function newMnemonic(strength: 128 | 256 = 128): string {
  return generateMnemonic(WORDLIST, strength);
}

/** NFKD + collapse whitespace + lowercase, the form BIP-39 hashes. */
export function normalizeMnemonic(phrase: string): string {
  return phrase.normalize("NFKD").trim().toLowerCase().split(/\s+/u).join(" ");
}

export type MnemonicProblem =
  | { ok: true; phrase: string }
  | { ok: false; reason: "length" | "word" | "checksum"; word?: string };

export async function checkMnemonic(phrase: string): Promise<MnemonicProblem> {
  const normalized = normalizeMnemonic(phrase);
  const words = normalized.length === 0 ? [] : normalized.split(" ");
  if (!VALID_LENGTHS.has(words.length)) return { ok: false, reason: "length" };

  const bits: number[] = [];
  for (const word of words) {
    const index = WORD_INDEX.get(word);
    if (index === undefined) return { ok: false, reason: "word", word };
    for (let bit = 10; bit >= 0; bit -= 1) bits.push((index >> bit) & 1);
  }

  const checksumBits = bits.length / 33;
  const entropyBits = bits.length - checksumBits;
  const entropy = new Uint8Array(entropyBits / 8);
  for (let i = 0; i < entropyBits; i += 1) {
    if (bits[i] !== 1) continue;
    const byte = i >> 3;
    entropy[byte] = (entropy[byte] ?? 0) | (0x80 >> i % 8);
  }

  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", entropy as BufferSource));
  for (let i = 0; i < checksumBits; i += 1) {
    const expected = (digest[i >> 3]! >> (7 - (i % 8))) & 1;
    if (bits[entropyBits + i] !== expected) return { ok: false, reason: "checksum" };
  }

  return { ok: true, phrase: normalized };
}

/** Suggestions for the import screen's per-word feedback. */
export function completeWord(prefix: string, limit = 4): string[] {
  const needle = prefix.trim().toLowerCase();
  if (needle.length < 2) return [];
  const out: string[] = [];
  for (const word of WORDLIST) {
    if (word.startsWith(needle)) {
      out.push(word);
      if (out.length === limit) break;
    }
  }
  return out;
}
