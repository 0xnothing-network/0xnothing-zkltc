/**
 * Folds text so that strings a person reads as the same compare equal: a page
 * or a token contract can write "NUЅD" with a Cyrillic Ѕ, or "LiteF0rge" with a
 * zero, and an exact comparison with the real name would let it pass. Pure and
 * import-free, so the service worker and the approval window share it.
 *
 * The same fold must be applied to both sides of every comparison: it maps the
 * real names too ("0xnothing" folds to "oxnothlng").
 */
const CONFUSABLES: Readonly<Record<string, string>> = {
  // Cyrillic
  "а": "a", "в": "b", "е": "e", "һ": "h", "і": "i", "ј": "j", "к": "k", "м": "m", "н": "h",
  "о": "o", "р": "p", "с": "c", "ѕ": "s", "т": "t", "у": "y", "х": "x", "ԁ": "d", "ԛ": "q", "ԝ": "w",
  // Greek
  "α": "a", "β": "b", "ε": "e", "ι": "i", "κ": "k", "ν": "v", "ο": "o", "ρ": "p", "τ": "t",
  "υ": "u", "χ": "x", "η": "n",
  // Latin look-alikes
  "ı": "i", "ł": "l", "ɩ": "i", "ɡ": "g", "ⅼ": "l",
  // Digits and strokes read as letters
  "0": "o", "1": "l", "i": "l", "|": "l",
};

/**
 * The Hangul fillers (U+115F, U+1160, U+3164, U+FFA0) are letters (Lo), so a
 * \p{Cf}, \p{Z} or \s check lets them through, yet Chrome draws each as a blank
 * gap: "Lite<U+3164>Forge" displays as "Lite Forge". Every check that refuses or
 * strips invisible characters must treat them the same way.
 */
export const IGNORABLE_LETTERS = /[\u115f\u1160\u3164\uffa0]/u;

export function foldConfusables(text: string): string {
  // NFKD turns fullwidth and styled letters into plain ones and splits accents
  // off, which are then dropped; lowercase before the table, whose keys are lower.
  const plain = text.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
  let folded = "";
  for (const char of plain) {
    const mapped = CONFUSABLES[char] ?? char;
    // "i" maps to "l" after the Cyrillic and Greek i's became "i".
    folded += CONFUSABLES[mapped] !== undefined && mapped !== char ? CONFUSABLES[mapped] : mapped;
  }
  return folded;
}

const PUNY_BASE = 36;
const PUNY_TMIN = 1;
const PUNY_TMAX = 26;
const PUNY_SKEW = 38;
const PUNY_DAMP = 700;
const PUNY_INITIAL_BIAS = 72;
const PUNY_INITIAL_N = 128;

function punyAdapt(delta: number, numPoints: number, firstTime: boolean): number {
  let d = firstTime ? Math.floor(delta / PUNY_DAMP) : delta >> 1;
  d += Math.floor(d / numPoints);
  let k = 0;
  while (d > ((PUNY_BASE - PUNY_TMIN) * PUNY_TMAX) >> 1) {
    d = Math.floor(d / (PUNY_BASE - PUNY_TMIN));
    k += PUNY_BASE;
  }
  return k + Math.floor(((PUNY_BASE - PUNY_TMIN + 1) * d) / (d + PUNY_SKEW));
}

function punyDigit(code: number): number {
  if (code >= 0x30 && code <= 0x39) return code - 22; // 0-9 -> 26-35
  if (code >= 0x41 && code <= 0x5a) return code - 0x41; // A-Z
  if (code >= 0x61 && code <= 0x7a) return code - 0x61; // a-z
  return PUNY_BASE;
}

/**
 * Decodes one IDNA label ("xn--..."), RFC 3492. A browser reports a host such as
 * "0хnothing.app" (Cyrillic х) in this ASCII form, so the look-alike check has
 * to read the letters it stands for. Labels without the prefix come back as they
 * are; malformed input returns null. Pure, no dependency.
 */
export function punycodeToUnicode(label: string): string | null {
  if (typeof label !== "string") return null;
  if (!/^xn--/i.test(label)) return label;
  const input = label.slice(4);
  if (input.length === 0 || input.length > 253) return null;
  const output: number[] = [];
  const basicEnd = input.lastIndexOf("-");
  for (let j = 0; j < Math.max(basicEnd, 0); j += 1) {
    const code = input.charCodeAt(j);
    if (code >= 0x80) return null;
    output.push(code);
  }
  let n = PUNY_INITIAL_N;
  let bias = PUNY_INITIAL_BIAS;
  let i = 0;
  for (let index = basicEnd > 0 ? basicEnd + 1 : 0; index < input.length; ) {
    const oldi = i;
    let w = 1;
    for (let k = PUNY_BASE; ; k += PUNY_BASE) {
      if (index >= input.length) return null;
      const digit = punyDigit(input.charCodeAt(index));
      index += 1;
      if (digit >= PUNY_BASE) return null;
      if (digit > Math.floor((0x7fffffff - i) / w)) return null;
      i += digit * w;
      const t = k <= bias ? PUNY_TMIN : k >= bias + PUNY_TMAX ? PUNY_TMAX : k - bias;
      if (digit < t) break;
      if (w > Math.floor(0x7fffffff / (PUNY_BASE - t))) return null;
      w *= PUNY_BASE - t;
    }
    const length = output.length + 1;
    bias = punyAdapt(i - oldi, length, oldi === 0);
    if (Math.floor(i / length) > 0x10ffff - n) return null;
    n += Math.floor(i / length);
    i %= length;
    if (n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff)) return null;
    output.splice(i, 0, n);
    i += 1;
  }
  return String.fromCodePoint(...output);
}

/**
 * Optimal string alignment distance (insertions, deletions, substitutions and
 * swaps of two neighbours), compared by code point. Returns max + 1 as soon as
 * the distance must exceed max, so a long hostile host costs little.
 */
export function damerauLevenshtein(a: string, b: string, max = 3): number {
  const s = Array.from(a);
  const u = Array.from(b);
  if (Math.abs(s.length - u.length) > max) return max + 1;
  let before: number[] = [];
  let previous = Array.from({ length: u.length + 1 }, (_, j) => j);
  for (let i = 1; i <= s.length; i += 1) {
    const current = [i];
    let rowMin = i;
    for (let j = 1; j <= u.length; j += 1) {
      const cost = s[i - 1] === u[j - 1] ? 0 : 1;
      // Every index read here is inside its row: the fallbacks only satisfy the type checker.
      let value = Math.min((previous[j] ?? 0) + 1, (current[j - 1] ?? 0) + 1, (previous[j - 1] ?? 0) + cost);
      if (i > 1 && j > 1 && s[i - 1] === u[j - 2] && s[i - 2] === u[j - 1]) {
        value = Math.min(value, (before[j - 2] ?? 0) + 1);
      }
      current.push(value);
      if (value < rowMin) rowMin = value;
    }
    if (rowMin > max) return max + 1;
    before = previous;
    previous = current;
  }
  const distance = previous[u.length] ?? max + 1;
  return distance > max ? max + 1 : distance;
}
