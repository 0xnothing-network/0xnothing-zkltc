import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  backupCheckChoices,
  backupCheckPositions,
  newMnemonic,
  sameWord,
} from "../../src/core/keyring/mnemonic.ts";

const PHRASE = "test test test test test test test test test test test junk";
const onboarding = readFileSync(new URL("../../src/ui/screens/Onboarding.tsx", import.meta.url), "utf8");

/** A scripted picker: each call takes the next value, reduced into range. */
function scripted(values: number[]): (bound: number) => number {
  let next = 0;
  return (bound) => values[next++ % values.length]! % bound;
}

test("the backup check asks three distinct positions, in range and ascending", () => {
  for (let run = 0; run < 200; run += 1) {
    const positions = backupCheckPositions(12);
    assert.equal(positions.length, 3);
    assert.equal(new Set(positions).size, 3, positions.join());
    assert.ok(positions.every((position) => Number.isInteger(position) && position >= 0 && position < 12));
    assert.deepEqual(positions, [...positions].sort((a, b) => a - b));
  }
  // Even a picker that always says 0 cannot repeat a position.
  assert.deepEqual(backupCheckPositions(12, 3, () => 0), [0, 1, 2]);
  assert.deepEqual(backupCheckPositions(24, 3, scripted([23, 0, 11])), [0, 12, 23]);
  // Every position can come up.
  const seen = new Set<number>();
  for (let run = 0; run < 400; run += 1) backupCheckPositions(12).forEach((position) => seen.add(position));
  assert.equal(seen.size, 12);
});

test("the choices hold the asked word once, among other words of the same phrase", () => {
  const words = newMnemonic().split(" ");
  for (const position of [0, 5, 11]) {
    const choices = backupCheckChoices(words, position);
    assert.ok(choices.length >= 2 && choices.length <= 6);
    assert.equal(choices.filter((word) => word === words[position]).length, 1);
    assert.equal(new Set(choices).size, choices.length, "no word is offered twice");
    assert.ok(choices.every((word) => words.includes(word)), "decoys come from the phrase");
  }
  // A phrase that repeats its words still offers the answer once and the rest once each.
  const repeated = PHRASE.split(" ");
  assert.deepEqual(backupCheckChoices(repeated, 11, 6, () => 0).sort(), ["junk", "test"]);
  assert.deepEqual(backupCheckChoices(repeated, 0, 6, () => 0).sort(), ["junk", "test"]);
  // The answer does not always sit first.
  const firsts = new Set<string>();
  for (let run = 0; run < 100; run += 1) firsts.add(backupCheckChoices(words, 3)[0]!);
  assert.ok(firsts.size > 1);
  assert.deepEqual(backupCheckChoices(words, 12), []);
});

test("an answer matches the phrase word in the form BIP-39 compares, nothing looser", () => {
  assert.equal(sameWord("junk", "junk"), true);
  assert.equal(sameWord("  JUNK ", "junk"), true);
  assert.equal(sameWord("café", "café"), true, "NFC and NFD forms are one word");
  assert.equal(sameWord("jun", "junk"), false);
  assert.equal(sameWord("junk junk", "junk"), false);
  assert.equal(sameWord("", "junk"), false);
  assert.equal(sameWord("   ", ""), false);
  assert.equal(sameWord("test", "junk"), false);
});

test("a created phrase passes the backup check before the password; a restore does not", () => {
  // Continue on the phrase starts the check, and only a full pass reaches the password.
  assert.match(onboarding, /disabled=\{!saved\}\s*onClick=\{startCheck\}/u);
  assert.match(onboarding, /if \(round >= check\.positions\.length\) \{\s*setCheck\(null\);\s*setStep\("password"\);/u);
  assert.match(onboarding, /if \(!sameWord\(value, words\[position\] \?\? ""\)\) \{\s*setWrong\(true\);/u);
  // A wrong word goes back to the same words: the phrase is not regenerated or cleared.
  const backToPhrase = onboarding.match(/const backToPhrase = \(\): void => \{[\s\S]*?\n {2}\};/u)?.[0] ?? "";
  assert.match(backToPhrase, /setStep\("create"\)/u);
  assert.doesNotMatch(backToPhrase, /setPhrase|newMnemonic|startCreate/u);
  // The restore flow still goes straight from the checked phrase to the password.
  assert.match(onboarding, /setPhrase\(checked\.phrase\);\s*setStep\("password"\);/u);
});

test("the header counts four steps when creating and three when restoring", () => {
  assert.match(onboarding, /title=\{t\("onb\.phraseTitle"\)\}\s*step="2 \/ 4"/u);
  assert.match(onboarding, /title=\{t\("onb\.verifyTitle"\)\} step="3 \/ 4"/u);
  assert.match(onboarding, /title=\{t\("onb\.importTitle"\)\} step="2 \/ 3"/u);
  assert.match(onboarding, /step=\{typed\.trim\(\)\.length > 0 \? "3 \/ 3" : "4 \/ 4"\}/u);
  // Create clears restore text, so neither Back nor the count mistakes it for a restore.
  assert.match(onboarding, /setPhrase\(newMnemonic\(\)\);[\s\S]{0,240}?setTyped\(""\);/u);
});
