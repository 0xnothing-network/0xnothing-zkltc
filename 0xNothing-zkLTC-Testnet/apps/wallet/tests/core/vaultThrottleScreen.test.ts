import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const unlock = readFileSync(new URL("../../src/ui/screens/Unlock.tsx", import.meta.url), "utf8");

test("the unlock wait ticks silently and is announced once per wait", () => {
  const block = unlock.match(/\{waiting \? \(([^]*?)\) : null\}/u)?.[1] ?? "";
  assert.ok(block.length > 0, "the wait block is found");
  // The ticking count is hidden from screen readers and sits in no live region.
  const ticking = block.match(/<p\b[^>]*>\s*\{t\("unlock\.throttled", \{ seconds: secondsUntil\(retryAt, now\) \}\)\}/u)?.[0] ?? "";
  assert.match(ticking, /aria-hidden="true"/u);
  assert.doesNotMatch(ticking, /role=|aria-live/u);
  assert.doesNotMatch(block, /<div role="status">/u);
  // The status copy changes only when a new wait begins.
  assert.match(
    block,
    /<p className="w-sr-only" role="status">\s*\{t\("unlock\.throttled", \{ seconds: announcedSeconds \}\)\}/u,
  );
  assert.match(unlock, /const announcedSeconds = useMemo\(\(\) => secondsUntil\(retryAt\), \[retryAt\]\);/u);
});
