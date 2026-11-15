import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parseHomeTab, parseSwapPair, restorableSwapPair } from "../../src/ui/lib/uiMemory.ts";

/** F7: the remembered Home tab and swap pair, and the spoken "Copied". */
const source = (path: string): string => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

test("only a known Home tab is read back", () => {
  for (const tab of ["token", "nft", "rwa"]) assert.equal(parseHomeTab(tab), tab);
  for (const bad of ["", "TOKEN", "history", null, undefined, 1, ["nft"], { tab: "nft" }]) {
    assert.equal(parseHomeTab(bad), null);
  }
});

test("a stored swap pair must have the right shape and sane lengths", () => {
  const pair = { networkId: "litvm", inId: "nusd", outId: "native" };
  assert.deepEqual(parseSwapPair(pair), pair);
  assert.deepEqual(parseSwapPair({ ...pair, extra: "x" }), pair);
  for (const bad of [
    null, "litvm", [pair],
    { ...pair, inId: "" },
    { ...pair, outId: 7 },
    { ...pair, networkId: "n".repeat(201) },
    { networkId: "litvm", inId: "nusd" },
  ]) assert.equal(parseSwapPair(bad), null);
});

test("a pair comes back only on its network, with both tokens listed and different", () => {
  const ids = ["native", "nusd", "erc20:0xabc"];
  const pair = { networkId: "litvm", inId: "erc20:0xabc", outId: "nusd" };
  assert.deepEqual(restorableSwapPair(pair, "litvm", ids), pair);
  assert.equal(restorableSwapPair(pair, "custom:1", ids), null);
  assert.equal(restorableSwapPair(pair, "litvm", ["native", "nusd"]), null);
  assert.equal(restorableSwapPair({ ...pair, outId: pair.inId }, "litvm", ids), null);
  assert.equal(restorableSwapPair("junk", "litvm", ids), null);
});

test("the screens read and write through the checks, and the erase removes both keys", () => {
  const home = source("src/ui/screens/Home.tsx");
  assert.match(home, /loadHomeTab\(\)\.then/u);
  assert.match(home, /tabPickedRef\.current\) return;/u);
  assert.match(home, /saveHomeTab\(name\);/u);
  const swap = source("src/ui/screens/Swap.tsx");
  assert.match(swap, /arrival\.params\.get\("finish"\) !== null/u);
  assert.match(swap, /restorableSwapPair\(stored, network\.id, ids\)/u);
  assert.match(swap, /saveSwapPair\(\{ networkId: network\.id, inId, outId \}\)/u);
  const vault = source("src/core/keyring/vault.ts");
  assert.match(vault, /persistentStore\.remove\(STORAGE_KEYS\.homeTab\)/u);
  assert.match(vault, /persistentStore\.remove\(STORAGE_KEYS\.swapPair\)/u);
});

test("a successful copy is said through one polite live region", async () => {
  const appended: Array<Record<string, unknown>> = [];
  const make = () => {
    const node: Record<string, unknown> = { textContent: "", isConnected: true, attrs: {} };
    node.setAttribute = (name: string, value: string) => {
      (node.attrs as Record<string, string>)[name] = value;
    };
    return node;
  };
  const previous = (globalThis as { document?: unknown }).document;
  (globalThis as { document?: unknown }).document = {
    body: { append: (node: Record<string, unknown>) => appended.push(node) },
    createElement: make,
  };
  try {
    const { announce } = await import("../../src/ui/lib/announce.ts");
    announce("Copied");
    announce("Copied");
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(appended.length, 1);
    const region = appended[0] as { textContent: string; className: string; attrs: Record<string, string> };
    assert.equal(region.textContent, "Copied");
    assert.equal(region.className, "w-sr-only");
    assert.deepEqual(region.attrs, { role: "status", "aria-live": "polite" });
  } finally {
    (globalThis as { document?: unknown }).document = previous;
  }
  const copy = source("src/ui/hooks/useCopy.ts");
  assert.match(copy, /setCopied\(true\);\s+\/\/[^\n]*\n\s+announce\(t\("common\.copied"\)\);/u);
});
