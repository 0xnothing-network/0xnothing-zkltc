import assert from "node:assert/strict";
import { test } from "node:test";
import { domainToASCII, domainToUnicode } from "node:url";
import { damerauLevenshtein, foldConfusables, punycodeToUnicode } from "../../src/core/lib/confusables.ts";

test("punycode decode matches known vectors and refuses malformed input", () => {
  // RFC 3492 section 7.1 samples (A Arabic, B Chinese, I Russian) and common labels.
  assert.equal(punycodeToUnicode("xn--egbpdaj6bu4bxfgehfvwxn"), "ليهمابتكلموشعربي؟");
  assert.equal(punycodeToUnicode("xn--ihqwcrb4cv8a8dqg056pqjye"), "他们为什么不说中文");
  assert.equal(punycodeToUnicode("xn--b1abfaaepdrnnbgefbadotcwatmq2g4l"), "почемужеонинеговорятпорусски");
  assert.equal(punycodeToUnicode("xn--mnchen-3ya"), "münchen");
  assert.equal(punycodeToUnicode("XN--bcher-kva"), "bücher");
  // A non-IDNA label comes back untouched.
  assert.equal(punycodeToUnicode("0xnothing"), "0xnothing");
  // The browser's own encoder and this decoder agree on look-alikes of the brand.
  for (const name of ["0хnothing", "0xnóthing", "0xnοthing", "ох-nothing"]) {
    const ascii = domainToASCII(`${name}.app`).split(".")[0] ?? "";
    assert.match(ascii, /^xn--/);
    assert.equal(punycodeToUnicode(ascii), domainToUnicode(`${ascii}.app`).split(".")[0]);
  }
  for (const bad of ["xn--", "xn--abc!", "xn--ü", "xn--zzzzzzzzzzzzzzzzzz", "xn--99999999999"]) {
    assert.equal(punycodeToUnicode(bad), null, bad);
  }
  assert.equal(punycodeToUnicode(42 as unknown as string), null);
});

test("damerau-levenshtein counts swaps as one edit and stops past the bound", () => {
  assert.equal(damerauLevenshtein("oxnothlng", "oxnothlng"), 0);
  assert.equal(damerauLevenshtein("oxnohtlng", "oxnothlng"), 1);
  assert.equal(damerauLevenshtein("oxnothng", "oxnothlng"), 1);
  assert.equal(damerauLevenshtein("oxnotthlng", "oxnothlng"), 1);
  assert.equal(damerauLevenshtein("nothlng", "oxnothlng"), 2);
  assert.equal(damerauLevenshtein("kitten", "sitting"), 3);
  assert.equal(damerauLevenshtein("abcdefgh", "zzzzzzzz", 2), 3);
  assert.equal(damerauLevenshtein("a".repeat(5000), "oxnothlng", 3), 4);
});

test("the fold the earlier proposals pinned is unchanged", () => {
  assert.equal(foldConfusables("0xNothing"), "oxnothlng");
  assert.equal(foldConfusables("0хnоthing"), "oxnothlng");
});
