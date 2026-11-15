import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { stringToHex } from "viem";
import { signMessageRisk } from "../../src/ui/lib/typedData.ts";

const approve = readFileSync(new URL("../../src/ui/screens/Approve.tsx", import.meta.url), "utf8");

// personal_sign of a 32-byte hash can authorise a transfer elsewhere (a Safe owner
// signature, a relayer order), so it must never be shown as a harmless message.
test("a message to sign is text, a hash or unreadable bytes", () => {
  assert.equal(signMessageRisk("hello"), "text");
  assert.equal(signMessageRisk("0x68656c6c6f"), "text");
  assert.equal(signMessageRisk(stringToHex("Sign in to app.test\nNonce: 12")), "text");
  assert.equal(signMessageRisk(`0x${"9f".repeat(32)}`), "hash");
  assert.equal(signMessageRisk(`0x${"00".repeat(32)}`), "hash");
  // 32 bytes that read as visible text are shown as that text.
  assert.equal(signMessageRisk(`0x${"41".repeat(32)}`), "text");
  assert.equal(signMessageRisk("0xff00"), "binary");
  assert.equal(signMessageRisk(`0x${"9f".repeat(33)}`), "binary");
  assert.equal(signMessageRisk("‮abc"), "binary");
  assert.equal(signMessageRisk(stringToHex("pay​me")), "binary");
});

test("Approve arms a risky signature only after its own tick", () => {
  assert.match(approve, /const signRisk = request\?\.kind === "sign" \? signMessageRisk\(request\.message \?\? ""\) : "text";/u);
  assert.match(approve, /const riskBlocked = signRisk !== "text" && \(requestId === null \|\| riskAckId !== requestId\);/u);
  assert.match(approve, /\|\| networkMismatch\n\s+\|\| riskBlocked\n\s+\|\| assetBlocked\n\s+\|\| chainBlocked\n\s+\|\| capError !== null\n\s+\|\| !actionGate\.tryEnter\(\)/u);
  assert.match(approve, /unreadable \|\| wrongChain\n\s+\|\| riskBlocked/u);
  assert.match(approve, /signRisk === "text" \? \(\n\s+<Note>\{t\("apr\.signNote"\)\}<\/Note>/u);
  assert.match(approve, /setRiskAckId\(event\.target\.checked \? request\.id : null\)/u);
});
