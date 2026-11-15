import assert from "node:assert/strict";
import { test } from "node:test";
import { PUBLIC_APP_URL } from "../../src/config/dapps.ts";
import { pumpTokenImageUrl } from "../../src/core/lib/pumpImage.ts";
import { evaluateModule } from "../../../web/tests/helpers/evaluateModule.ts";

interface Token { id: string; symbol: string; logo?: string; builtin: boolean; verified?: boolean }
const { BUILTIN_TOKENS, NUSD_TOKEN, customToken, impersonatesBuiltin } = evaluateModule<{
  BUILTIN_TOKENS: readonly Token[];
  NUSD_TOKEN: Token;
  customToken(input: { address: string; symbol: string; name: string; decimals: number }): Token;
  impersonatesBuiltin(token: Token): boolean;
}>(new URL("../../src/config/assets.ts", import.meta.url), {
  // Every address is a placeholder; only symbols and flags are under test.
  "./contracts": { CONTRACTS: new Proxy({}, { get: () => `0x${"ab".repeat(20)}` }) },
});

const CID = "QmYwAPJzv5CZsnAzt8auVZRnGiRAhT1h9Yhcs4Zc1JxZ6H";

test("0xFi proxy images are revalidated and rebuilt for the extension", () => {
  assert.equal(
    pumpTokenImageUrl(`/api/pump/image?cid=${CID}&symbol=BAD`, "PX"),
    `${PUBLIC_APP_URL}/api/pump/image?cid=${CID}&symbol=PX`,
  );
  assert.equal(
    pumpTokenImageUrl(`${PUBLIC_APP_URL}/api/pump/image?cid=${CID}`, "FI"),
    `${PUBLIC_APP_URL}/api/pump/image?cid=${CID}&symbol=FI`,
  );
});

test("a lookalike host cannot become a token image source", () => {
  assert.equal(
    pumpTokenImageUrl(`https://0xnothing.xyz.evil.example/api/pump/image?cid=${CID}`),
    undefined,
  );
});

test("only a built-in token may wear a bundled logo", () => {
  // An imported token's imageURI() is remote input: naming the official art
  // must not make a second "NUSD" look like the real one.
  assert.equal(pumpTokenImageUrl("tokens/NUSD_LOGO.jpg", "NUSD"), undefined);
  assert.equal(pumpTokenImageUrl("tokens/NUSD_LOGO.jpg", "NUSD", false), undefined);
  assert.equal(pumpTokenImageUrl("tokens/NUSD_LOGO.jpg", "NUSD", true), "tokens/NUSD_LOGO.jpg");
  assert.equal(pumpTokenImageUrl("tokens/../popup.html", "X", true), undefined);
});

test("every built-in sets builtin, so it keeps its art", () => {
  for (const token of BUILTIN_TOKENS) {
    assert.equal(token.builtin, true, token.symbol);
    if (token.logo) assert.equal(pumpTokenImageUrl(token.logo, token.symbol, token.builtin), token.logo);
  }
});

test("an imported token with a built-in symbol is flagged, the built-in is not", () => {
  const fake = customToken({
    address: "0x1111111111111111111111111111111111111111",
    symbol: "nusd",
    name: "Nothing USD",
    decimals: 18,
  });
  assert.equal(impersonatesBuiltin(fake), true);
  assert.equal(impersonatesBuiltin({ ...fake, symbol: "PEPE" }), false);
  assert.equal(impersonatesBuiltin(NUSD_TOKEN), false);
});
