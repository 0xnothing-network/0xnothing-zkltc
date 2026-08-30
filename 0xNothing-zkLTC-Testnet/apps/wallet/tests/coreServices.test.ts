import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const blockTicker = readFileSync(new URL("../src/core/rpc/blockTicker.ts", import.meta.url), "utf8");
const portfolio = readFileSync(new URL("../src/core/services/portfolio.ts", import.meta.url), "utf8");
const prices = readFileSync(new URL("../src/core/services/prices.ts", import.meta.url), "utf8");

test("the shared block clock remains non-overlapping, adaptive and visibility-aware", () => {
  assert.match(blockTicker, /if \(!running \|\| listeners\.size === 0 \|\| inFlight \|\| hidden\(\)\) return;/u);
  assert.match(blockTicker, /setTimeout\(\(\) =>/u);
  assert.doesNotMatch(blockTicker, /setInterval\(/u);
  assert.match(blockTicker, /failures = Math\.min\(failures \+ 1, 4\)/u);
  assert.match(blockTicker, /if \(document\.hidden\) return;/u);
});

test("partial RPC reads cannot become complete zero-value portfolio snapshots", () => {
  assert.match(portfolio, /if \(failedBalance !== undefined\) throw failedBalance\.error;/u);
  assert.match(prices, /const hasPrice = priceCall\.status === "success" && priceCall\.result\[0\] > 0n;/u);
  assert.match(prices, /priceSource === "none"[\s\S]*stale: false/u);
});

test("price and portfolio reads retain their single-flight guards", () => {
  assert.match(prices, /const active = priceLoads\.get\(key\);[\s\S]*if \(active !== undefined\) return active;/u);
  assert.match(portfolio, /const active = portfolioLoads\.get\(key\);[\s\S]*if \(active !== undefined\) return active;/u);
});
