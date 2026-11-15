import { BUILTIN_TOKENS, impersonatesBuiltin, type WalletToken } from "../../config/assets";
import { foldConfusables, IGNORABLE_LETTERS } from "../../core/lib/confusables";

/**
 * A native option cannot hold the verified mark, so a token that only borrows
 * a built-in symbol says so in its text; two "NUSD" rows never read the same.
 */
export function tokenOptionText(token: WalletToken, notOfficial: string): string {
  const base = `${token.symbol} — ${token.name}`;
  return impersonatesBuiltin(token) ? `${base} · ${notOfficial}` : base;
}

/** Every Hangul filler, for replace: each is a letter Chrome draws as a blank gap. */
const ALL_IGNORABLE_LETTERS = new RegExp(IGNORABLE_LETTERS.source, "gu");

/**
 * Folded, and without format characters, separators, white space or Hangul
 * fillers anywhere: trim() keeps a zero-width space inside "NUSD", which still
 * displays as NUSD, and "NU<U+3164>SD" displays as "NU SD".
 */
function readAs(text: string): string {
  return foldConfusables(text.replace(/[\p{Cf}\p{Z}\s]/gu, "").replace(ALL_IGNORABLE_LETTERS, ""));
}

const FOLDED_BUILTIN_SYMBOLS = new Set(BUILTIN_TOKENS.map((token) => readAs(token.symbol)));
const FOLDED_BUILTIN_NAMES = new Set(BUILTIN_TOKENS.map((token) => readAs(token.name)));

/**
 * Whether a token a dapp offers reads as a built-in one: its contract's symbol
 * or name equals a built-in's once look-alike letters are folded ("NUЅD" with a
 * Cyrillic Ѕ, "NUSD" itself). Used by the watch-asset approval only, so every
 * other list keeps impersonatesBuiltin's exact rule.
 */
export function foldedImpersonation(symbol: string, name: string): boolean {
  return FOLDED_BUILTIN_SYMBOLS.has(readAs(symbol))
    || FOLDED_BUILTIN_NAMES.has(readAs(name));
}
