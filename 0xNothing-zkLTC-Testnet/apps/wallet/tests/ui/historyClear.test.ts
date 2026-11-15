import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { CONFIRM_TAP_MIN_MS, CONFIRM_TAP_MS, secondTapFires } from "../../src/ui/lib/twoStep.ts";

test("History Clear needs a second, deliberate tap inside the window", () => {
  assert.equal(secondTapFires(null, 1_000), false);
  assert.equal(secondTapFires(1_000, 1_000 + CONFIRM_TAP_MIN_MS - 1), false, "a double-tap does not clear");
  assert.equal(secondTapFires(1_000, 1_000 + CONFIRM_TAP_MIN_MS), true);
  assert.equal(secondTapFires(1_000, 1_000 + CONFIRM_TAP_MS), true);
  assert.equal(secondTapFires(1_000, 1_000 + CONFIRM_TAP_MS + 1), false, "a late tap re-arms");
  assert.equal(secondTapFires(1_000, 500), false, "a clock moved back never clears");
});

test("the Clear button arms, relabels and clears only this network", () => {
  const source = readFileSync(new URL("../../src/ui/screens/History.tsx", import.meta.url), "utf8");
  assert.match(source, /onClick=\{tapClear\}/u);
  assert.match(source, /clearArmedAt !== null \? t\("hist\.clearConfirm"\) : t\("hist\.clear"\)/u);
  assert.match(source, /setTimeout\(\(\) => setClearArmedAt\(null\), CONFIRM_TAP_MS\)/u);
  assert.match(source, /await clearRecords\(address, network\);/u);
  assert.doesNotMatch(source, /onClick=\{\(\) => void clear\(\)\}/u);
});
