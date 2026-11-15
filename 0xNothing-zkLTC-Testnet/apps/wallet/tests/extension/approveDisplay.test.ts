import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { getAddress } from "viem";
import { formatFee, groupHex } from "../../src/core/lib/format.ts";

const approve = readFileSync(new URL("../../src/ui/screens/Approve.tsx", import.meta.url), "utf8");

// Address poisoning matches the head and tail of an address the user knows, so the
// approval window shows every target that receives funds or rights in full.
test("the approval window shows recipients, spenders, operators and targets in full", () => {
  assert.match(approve, /shown = getAddress\(address\);/u);
  assert.match(approve, /<span className="w-approve-address">\{groupHex\(shown\)\}<\/span>/u);
  assert.equal((approve.match(/label=\{t\("send\.recipient"\)\} value=\{<FullAddress address=\{effect\.to\} \/>\}/gu) ?? []).length, 2);
  assert.match(approve, /label=\{t\("apr\.spender"\)\} value=\{<FullAddress address=\{effect\.spender\} \/>\}/u);
  assert.match(approve, /label=\{t\("apr\.operator"\)\} value=\{<FullAddress address=\{effect\.operator\} \/>\}/u);
  assert.match(approve, /t\("apr\.deploy"\) : <FullAddress address=\{tx\.to\} \/>/u);
  assert.doesNotMatch(approve, /shortenAddress\(effect\.(to|spender|operator)/u);
  assert.doesNotMatch(approve, /shortenAddress\(tx\.to/u);
  // What the row shows is the whole address, nothing dropped or reordered.
  const lower = `0x${"ab12".repeat(10)}`;
  assert.equal(groupHex(getAddress(lower)).replaceAll(" ", "").toLowerCase(), lower);
});

// LiteForge gas is about 0.01 gwei, so a whole transaction costs well under 1e-6.
test("the approval window's fee is not rounded down to zero", () => {
  assert.match(approve, /amount: formatFee\(preview\.data\.feeWei, nativeToken\.decimals\),/u);
  assert.doesNotMatch(approve, /formatAmount\(preview\.data\.feeWei/u);
  assert.equal(formatFee(302_400_000_000n, 18), "0.0000003");
  assert.match(formatFee(1n, 18), /^</u);
});

// The page title is the page's own text: only the browser-reported origin may earn
// the official mark or the look-alike warning, and the warning never blocks Approve.
test("the official-site mark is computed from request.origin, never from request.title", () => {
  assert.match(approve, /const mark = siteMark\(request\.origin\);/u);
  assert.equal((approve.match(/siteMark\(/gu) ?? []).length, 1);
  assert.doesNotMatch(approve, /siteMark\([^)]*title/u);
  assert.match(approve, /data-lookalike=\{mark === "lookalike" \? "true" : undefined\}/u);
  assert.match(approve, /\{mark === "lookalike" \? \(\s*<div role="alert">\s*<Note tone="error">\{t\("apr\.lookalike"\)\}<\/Note>/u);
  assert.match(approve, /\{mark === "official" \? \(\s*<span className="w-approve-official">/u);
  assert.doesNotMatch(approve, /mark === "lookalike"[^\n]*disabled/u);
});

// F18: the dapp's approve may be signed with a lower amount. What the window shows,
// simulates and signs must be the same bytes, and the editor must stay away from
// anything that is not a verified ERC-20 approve.
test("effect, preview, raw calldata and execution read signedData, not tx.data", () => {
  assert.match(approve, /const effect = tx !== null \? callEffect\(tx\.to, signedData\) : requestedEffect;/u);
  assert.match(approve, /previewRaw\(\{[^}]*data: signedData,[^}]*\}\)/su);
  assert.match(approve, /signedData \?\? "",/u);
  assert.match(approve, /<p className="w-code w-mono-break w-approve-raw">\{signedData\}<\/p>/u);
  assert.match(approve, /const data = signedData;/u);
  assert.match(approve, /request\.kind === "transaction" \? \{ data \} : undefined,\s*\);/u);
  // tx.data is read only to learn what was requested, and as signedData's default.
  const reads = approve.split("\n").filter((line) => /tx\??\.data/u.test(line)).map((line) => line.trim());
  assert.deepEqual(reads, [
    "? callEffect(tx.to, tx.data)",
    "const requested = tx === null || tx.to === undefined ? null : parseApproveCall(tx.data);",
    "? tx.data",
    ": rewriteApproveAmount(tx.data, capAmount) ?? tx.data;",
    "const selector = tx?.data !== undefined && tx.data.length >= 10 ? tx.data.slice(0, 10) : null;",
  ]);
  assert.doesNotMatch(approve, /data: tx\.data/u);
});

test("Approve is disabled while the cap input is invalid", () => {
  assert.match(approve, /\|\| capError !== null\n\s*\|\| !actionGate\.tryEnter\(\)/u);
  assert.match(approve, /riskBlocked \|\| assetBlocked \|\| chainBlocked \|\| capError !== null\n/u);
  assert.match(approve, /readOnly=\{busy\}/u);
});

test("no editor when the token metadata or the ERC-165 read failed", () => {
  assert.match(approve, /const editable = requested !== null && capMeta != null && nftRead\.data\?\.nft === false;/u);
  assert.match(approve, /const capInput = editable \? normalizeDecimalInput\(capText\) : "";/u);
  assert.match(approve, /!editable \|\| capInput === "" \|\| capAmount === null \|\| capError !== null\n\s*\? tx\.data/u);
  assert.match(approve, /functionName: "supportsInterface", args: \[ERC721_INTERFACE_ID\]/u);
  assert.match(approve, /\{editable \? \(/u);
  assert.match(approve, /<Note>\{t\("apr\.capLocked"\)\}<\/Note>/u);
});

test("an ERC-721 approve gets no Spending cap panel", () => {
  // Its word is a token id; a hashed id at or above 2^128 would read as "Unlimited".
  assert.match(approve, /\{requested !== null && nftRead\.data\?\.nft !== true \? \(\n\s+<Panel title=\{t\("apr\.capTitle"\)\}>/u);
  assert.equal(approve.match(/t\("apr\.capTitle"\)/gu)?.length, 1);
});
