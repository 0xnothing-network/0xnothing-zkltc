import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mock, test } from "node:test";
import {
  backdropCloseAllowed,
  createArmTimer,
  REVIEW_ARM_MS,
  SHEET_BACKDROP_GRACE_MS,
} from "../../src/ui/lib/armTimer.ts";

test("a review arms only after its delay and disarms on a new key", () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const armedKeys: string[] = [];
    const timer = createArmTimer(REVIEW_ARM_MS, (key) => armedKeys.push(key));
    assert.equal(REVIEW_ARM_MS, 500);
    timer.start("a");
    assert.equal(timer.armed("a"), false);
    mock.timers.tick(499);
    assert.equal(timer.armed("a"), false);
    mock.timers.tick(1);
    assert.equal(timer.armed("a"), true);
    assert.deepEqual(armedKeys, ["a"]);

    timer.start("b");
    assert.equal(timer.armed("a"), false);
    assert.equal(timer.armed("b"), false);
    mock.timers.tick(500);
    assert.equal(timer.armed("b"), true);
    assert.equal(timer.armed("a"), false);

    timer.start("c");
    timer.stop();
    mock.timers.tick(1_000);
    assert.equal(timer.armed("c"), false);
    assert.deepEqual(armedKeys, ["a", "b"]);
  } finally {
    mock.timers.reset();
  }
});

test("a backdrop tap is ignored while the opening tap settles", () => {
  assert.equal(backdropCloseAllowed(1_000, 1_000), false);
  assert.equal(backdropCloseAllowed(1_000, 1_000 + SHEET_BACKDROP_GRACE_MS - 1), false);
  assert.equal(backdropCloseAllowed(1_000, 1_000 + SHEET_BACKDROP_GRACE_MS), true);
});

test("every in-wallet review sheet gates Confirm on the arm timer", () => {
  const read = (path: string): string => readFileSync(new URL(`../../src/ui/${path}`, import.meta.url), "utf8");
  const review = read("components/TransactionReview.tsx");
  assert.match(review, /disabled=\{busy \|\| !ready \|\| !armed\}/u);
  assert.match(review, /backdropCloseAllowed\(shownAt, Date\.now\(\)\)/u);
  for (const screen of ["screens/Swap.tsx", "screens/Lend.tsx"]) {
    const source = read(screen);
    assert.match(source, /useReviewArm\(/u, screen);
    assert.match(source, /disabled=\{busy \|\| !ready \|\| !reviewCurrent \|\| !reviewArmed[ }]/u, screen);
    assert.match(source, /\|\| !reviewArmed\n/u, screen);
    assert.match(source, /backdropCloseAllowed\(reviewShownAt\.current, Date\.now\(\)\)/u, screen);
  }
  for (const screen of ["screens/Send.tsx", "screens/send/SendNft.tsx", "screens/MintNusd.tsx", "screens/Earn.tsx", "screens/home/RwaList.tsx"]) {
    assert.match(read(screen), /armKey=\{/u, screen);
  }
});
