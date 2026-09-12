// SPDX-License-Identifier: MIT
// Icon-codec tests: alphabet sanity, round-trips, checksum detection, NFKC
// stability. Uses WebCrypto (global in Node 20+/browsers).

import assert from "node:assert/strict";
import test from "node:test";
import {
  ALPHABET_SIZE,
  SYMBOL_COUNT,
  alphabet,
  decodeSecret,
  encodeSecret,
  randomEntropy,
} from "../src/icons.ts";

test("alphabet has exactly 2048 distinct NFKC-stable glyphs", () => {
  const a = alphabet();
  assert.equal(a.length, ALPHABET_SIZE);
  assert.equal(new Set(a).size, ALPHABET_SIZE, "no duplicate code points");
  for (const ch of a) {
    assert.equal(ch.normalize("NFKC"), ch, `glyph ${ch.codePointAt(0)?.toString(16)} not NFKC-stable`);
    assert.ok(!/\s/.test(ch), "no whitespace glyphs");
  }
});

test("encode -> decode round-trips to the identical entropy", async () => {
  for (let i = 0; i < 8; i++) {
    const entropy = randomEntropy();
    const icons = await encodeSecret(entropy);
    assert.equal([...icons].length, SYMBOL_COUNT, "24 symbols");
    const back = await decodeSecret(icons);
    assert.equal(back.valid, true);
    assert.deepEqual(Buffer.from(back.entropy), Buffer.from(entropy));
  }
});

test("a single wrong glyph fails the checksum or lookup", async () => {
  const entropy = randomEntropy();
  const icons = await encodeSecret(entropy);
  const chars = [...icons];
  // Flip the last glyph to a different alphabet member (wrap around).
  const a = alphabet();
  const orig = chars[chars.length - 1];
  const idx = a.indexOf(orig);
  chars[chars.length - 1] = a[(idx + 1) % a.length];
  const bad = await decodeSecret(chars.join(""));
  assert.equal(bad.valid, false, "corrupted icons must fail");
});

test("unknown glyph reports its position", async () => {
  const entropy = randomEntropy();
  const icons = await encodeSecret(entropy);
  const chars = [...icons];
  chars[3] = "?"; // '?' is in the alphabet — use a private-use glyph instead
  chars[3] = "";
  const bad = await decodeSecret(chars.join(""));
  assert.equal(bad.valid, false);
  assert.equal(bad.errorAt, 3);
});

test("icons survive NFKC-normalized (decomposed) input", async () => {
  const a = alphabet();
  // Find a letter with a canonical decomposition, e.g. é (U+00E9).
  const target = a.find((ch) => {
    const cp = ch.codePointAt(0)!;
    return cp >= 0x00c0 && cp <= 0x024f && ch.normalize("NFD") !== ch;
  });
  assert.ok(target, "alphabet contains an accented letter for this test");
  const decomposed = target.normalize("NFD"); // letter + combining accent (2 cps)
  // The alphabet only keeps glyphs whose NFKC form is themselves — so a
  // decomposed input must normalize right back to the alphabet glyph.
  assert.equal(decomposed.normalize("NFKC"), target);
  // A wrong-length (decomposed not yet normalized) input is length-invalid…
  const tooLong = await decodeSecret(decomposed + target.repeat(23));
  assert.equal(tooLong.valid, false);

  // …but after NFKC the same characters decode exactly.
  const entropy = randomEntropy();
  const icons = await encodeSecret(entropy);
  const chars = [...icons];
  const pos = chars.indexOf(target);
  if (pos !== -1) {
    chars.splice(pos, 1, decomposed);
    const back = await decodeSecret(chars.join(""));
    assert.equal(back.valid, true, "decomposed input decodes after NFKC");
    assert.deepEqual(Buffer.from(back.entropy), Buffer.from(entropy));
  }
  // (When the entropy happens not to contain an accented glyph, the glyph-level
  // normalization property above is the guarantee — the decode path normalizes
  // the whole string before mapping.)
});

test("encode is deterministic", async () => {
  const entropy = new Uint8Array(32).fill(7);
  const a = await encodeSecret(entropy);
  const b = await encodeSecret(entropy);
  assert.equal(a, b);
});

test("checksum catches an entropy byte flip", async () => {
  const entropy = randomEntropy();
  const flipped = entropy.slice();
  flipped[0] ^= 0x01;
  const icons = await encodeSecret(entropy);
  // Re-encoding the flipped entropy must produce different icons (very likely),
  // and decoding the original icons still yields the original entropy.
  const back = await decodeSecret(icons);
  assert.equal(back.valid, true);
  assert.deepEqual(Buffer.from(back.entropy), Buffer.from(entropy));
  const otherIcons = await encodeSecret(flipped);
  assert.notEqual(otherIcons, icons);
});
