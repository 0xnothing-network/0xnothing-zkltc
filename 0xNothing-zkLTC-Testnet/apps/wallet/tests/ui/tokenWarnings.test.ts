import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { evaluateModule } from "../../../web/tests/helpers/evaluateModule.ts";
import { foldConfusables, IGNORABLE_LETTERS } from "../../src/core/lib/confusables.ts";

interface Token { id: string; symbol: string; name: string; logo?: string; builtin: boolean; verified?: boolean }
const assets = evaluateModule<{
  NUSD_TOKEN: Token;
  customToken(input: { address: string; symbol: string; name: string; decimals: number }): Token;
  impersonatesBuiltin(token: Token): boolean;
}>(new URL("../../src/config/assets.ts", import.meta.url), {
  // Every address is a placeholder; only symbols and flags are under test.
  "./contracts": { CONTRACTS: new Proxy({}, { get: () => `0x${"ab".repeat(20)}` }) },
});
const { foldedImpersonation, tokenOptionText } = evaluateModule<{
  tokenOptionText(token: Token, notOfficial: string): string;
  foldedImpersonation(symbol: string, name: string): boolean;
}>(new URL("../../src/ui/lib/tokenLabel.ts", import.meta.url), {
  "../../config/assets": assets,
  "../../core/lib/confusables": { foldConfusables, IGNORABLE_LETTERS },
});

test("the watch-asset approval flags a homoglyph of a built-in symbol", () => {
  // Cyrillic Ѕ, fullwidth letters, other case, padding, and the plain symbol itself.
  for (const symbol of ["NUSD", "nusd", "NUЅD", "ＮＵＳＤ", " NUSD "]) {
    assert.equal(foldedImpersonation(symbol, "Some token"), true, symbol);
  }
  assert.equal(foldedImpersonation("XYZ", "Nothing USD"), true, "a built-in name");
  assert.equal(foldedImpersonation("XYZ", "N0thing UЅD"), true, "a folded built-in name");
  for (const symbol of ["NUSDC", "PEPE", "USD"]) assert.equal(foldedImpersonation(symbol, "Pepe"), false, symbol);
});

test("a zero-width space or word joiner inside a built-in symbol or name is still flagged", () => {
  for (const hidden of [0x200b, 0x2060, 0x00ad, 0x200d]) {
    const mark = String.fromCodePoint(hidden);
    assert.equal(foldedImpersonation(`NU${mark}SD`, "Some token"), true, hidden.toString(16));
    assert.equal(foldedImpersonation("XYZ", `Nothing${mark} USD`), true, hidden.toString(16));
  }
  assert.equal(foldedImpersonation("NU SD", "Some token"), true, "a space");
});

test("a Hangul filler inside a built-in symbol or name is still flagged", () => {
  // A letter (Lo) that Chrome draws as a blank gap: "NU<filler>SD" reads as "NU SD".
  for (const filler of [0x115f, 0x1160, 0x3164, 0xffa0]) {
    const gap = String.fromCodePoint(filler);
    assert.equal(foldedImpersonation(`NU${gap}SD`, "Some token"), true, filler.toString(16));
    assert.equal(foldedImpersonation("XYZ", `Nothing${gap}USD`), true, filler.toString(16));
  }
  assert.equal(foldedImpersonation("\ud55c\uad6d", "Some token"), false, "real Hangul");
});

const read = (path: string): string => readFileSync(new URL(`../../src/ui/${path}`, import.meta.url), "utf8");

test("a Send option that borrows a built-in symbol says it is not official", () => {
  const fake = assets.customToken({
    address: `0x${"cd".repeat(20)}`,
    symbol: "nusd",
    name: "Nothing USD",
    decimals: 18,
  });
  assert.equal(tokenOptionText(fake, "Not the official token"), "nusd — Nothing USD · Not the official token");
  assert.equal(tokenOptionText(assets.NUSD_TOKEN, "Not the official token"), `NUSD — ${assets.NUSD_TOKEN.name}`);
  const other = assets.customToken({ address: `0x${"ef".repeat(20)}`, symbol: "PX", name: "Pixel", decimals: 18 });
  assert.equal(tokenOptionText(other, "Not the official token"), "PX — Pixel");
});

test("the Send picker, the Swap picker and token import all flag a borrowed symbol", () => {
  const select = read("components/TokenSelect.tsx");
  assert.match(select, /<VerifiedMark verified=\{value\.verified\} \/>/u);
  assert.match(select, /tokenOptionText\(token, t\("tok\.notOfficial"\)\)/u);
  assert.match(select, /impersonatesBuiltin\(value\)\n\s+\? <Note tone="error">\{t\("tok\.notOfficialWarn"/u);
  assert.match(read("components/SwapTokenPicker.tsx"), /impersonatesBuiltin\(option\.token\)\n\s+\? <span className="w-token-warn">/u);
  assert.match(read("screens/settings/TokenManager.tsx"), /BUILTIN_SYMBOLS\.has\(preview\.data\.symbol\.trim\(\)\.toUpperCase\(\)\)/u);
});

test("the send reviews show the recipient in full, grouped and checksummed", () => {
  assert.match(read("screens/Send.tsx"), /<span className="w-review-address">\{groupHex\(getAddress\(job\.to\)\)\}<\/span>/u);
  assert.match(read("screens/send/SendNft.tsx"), /<span className="w-review-address">\{groupHex\(getAddress\(recipient\)\)\}<\/span>/u);
  const css = readFileSync(new URL("../../src/styles/suite/forms.css", import.meta.url), "utf8");
  assert.match(css, /\.w-swap-review \.w-row dd \.w-review-address \{\n\s+display: block;\n\s+white-space: normal;/u);
});
