import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const blockTicker = readFileSync(new URL("../../src/core/rpc/blockTicker.ts", import.meta.url), "utf8");
const portfolio = readFileSync(new URL("../../src/core/services/portfolio.ts", import.meta.url), "utf8");
const prices = readFileSync(new URL("../../src/core/services/prices.ts", import.meta.url), "utf8");
const lend = readFileSync(new URL("../../src/core/services/lend.ts", import.meta.url), "utf8");
const tokens = readFileSync(new URL("../../src/core/services/tokens.ts", import.meta.url), "utf8");
const storage = readFileSync(new URL("../../src/core/platform/storage.ts", import.meta.url), "utf8");
const inpage = readFileSync(new URL("../../src/extension/inpage.ts", import.meta.url), "utf8");
const cryptoSource = readFileSync(new URL("../../src/core/keyring/crypto.ts", import.meta.url), "utf8");

test("the shared block clock remains non-overlapping, adaptive and visibility-aware", () => {
  assert.match(blockTicker, /if \(!running \|\| listeners\.size === 0 \|\| inFlight \|\| hidden\(\)\) return;/u);
  assert.match(blockTicker, /setTimeout\(\(\) =>/u);
  assert.doesNotMatch(blockTicker, /setInterval\(/u);
  assert.match(blockTicker, /failures = Math\.min\(failures \+ 1, 4\)/u);
  assert.match(blockTicker, /if \(document\.hidden\) return;/u);
  assert.match(blockTicker, /const pollNetworkKey = syncNetwork\(\);/u);
  assert.match(blockTicker, /if \(networkIdentity\(activeNetwork\) !== pollNetworkKey\) return;/u);
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

test("multi-transaction lending actions pin one execution context", () => {
  assert.match(lend, /const context = \{ network: activeNetwork, client: publicClient \}/u);
  assert.match(lend, /ensureAllowance\([\s\S]*?\}, context\);[\s\S]*?writeCall\([\s\S]*?\}, context\);/u);
});

test("wallet process caches and listener registries stay bounded", () => {
  assert.match(tokens, /MAX_METADATA_CACHE_ENTRIES/u);
  assert.match(tokens, /while \(metadataCache\.size >= MAX_METADATA_CACHE_ENTRIES\)/u);
  assert.match(storage, /if \(set\.size === 0\) watchers\.delete\(key\);/u);
  assert.match(inpage, /if \(set\.size === 0\) listeners\.delete\(name\);/u);
});

test("temporary plaintext, password and key buffers are zeroized", () => {
  assert.match(cryptoSource, /passwordBytes\.fill\(0\)/u);
  assert.match(cryptoSource, /plaintext\?\.fill\(0\)|plaintext\.fill\(0\)/u);
  assert.match(cryptoSource, /bytes\.fill\(0\)/u);
});
