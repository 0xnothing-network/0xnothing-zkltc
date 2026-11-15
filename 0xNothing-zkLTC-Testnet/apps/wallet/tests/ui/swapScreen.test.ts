import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const read = (path: string): string => readFileSync(new URL(`../../src/ui/${path}`, import.meta.url), "utf8");
const swap = read("screens/Swap.tsx");

function confirmBody(): string {
  const start = swap.indexOf("const confirmSwap = async");
  const end = swap.indexOf("\n  };\n", start);
  assert.ok(start > 0 && end > start);
  return swap.slice(start, end);
}

test("a stale reviewed quote is replaced on the open sheet, never confirmed", () => {
  const body = confirmBody();
  const check = body.indexOf("if (!quoteFresh(reviewRoute, Date.now(), route, settings.slippageBps))");
  assert.ok(check > 0, "confirmSwap checks the reviewed quote");
  assert.ok(check < body.indexOf("await executeSwap("), "before anything is signed");
  assert.match(body, /setError\(t\("err\.quoteStale"\)\);\n\s+if \(live\) setReviewRoute\(route\);/u);
  // The arm key carries the quote time, so the swapped-in quote re-arms Confirm.
  assert.match(swap, /useReviewArm\(\n\s+reviewOpen && reviewRoute !== null \? `\$\{reviewIdentity\}:\$\{reviewRoute\.quotedAt\}` : null,/u);
});

test("a failed second leg refreshes and restarts the form from the NUSD held", () => {
  const body = confirmBody();
  assert.match(
    body,
    /if \(cause instanceof StagedSwapError\) \{[\s\S]*?setInId\(NUSD_TOKEN\.id\);\n\s+setAmount\(""\);\n\s+\}\n\s+refresh\(\);\n\s+\} finally/u,
  );
});

test("an interrupted two-stage swap is offered on Swap and Home and re-quoted", () => {
  const prompt = read("components/StagedSwapPrompt.tsx");
  assert.match(prompt, /loadPendingStagedSwap\(address\)/u);
  // Only Dismiss forgets the marker; Finish prefills and keeps the reminder
  // until the NUSD is spent, since the quote can fail or the popup close first.
  assert.match(prompt, /if \(finish\) onFinish\(pending\);\n\s+else void dismissPendingStagedSwap\(pending\)/u);
  assert.equal((prompt.match(/dismissPendingStagedSwap\(/gu) ?? []).length, 1);
  assert.match(prompt, /t\("common\.dismiss"\)/u);
  assert.match(prompt, /t\("swap\.finish"\)/u);
  assert.match(swap, /<StagedSwapPrompt[\s\S]*?onFinish=\{finishPending\}/u);
  // Finishing fills the form only; the quote, the review and the floor are new.
  assert.match(swap, /const prefillFinish = \(tokenOutId: string, nusd: string\): void => \{\n\s+setInId\(NUSD_TOKEN\.id\);/u);
  const home = read("screens/Home.tsx");
  assert.match(home, /<StagedSwapPrompt[\s\S]*?navigate\(`#\/swap\?\$\{params\.toString\(\)\}`\)/u);
});
