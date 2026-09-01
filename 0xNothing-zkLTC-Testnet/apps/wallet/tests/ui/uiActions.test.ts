import assert from "node:assert/strict";
import { test } from "node:test";
import { createActionGate } from "../../src/ui/lib/actionGate.ts";
import { normalizeDecimalInput } from "../../src/ui/lib/decimalInput.ts";
import { reviewKey } from "../../src/ui/lib/reviewKey.ts";
import { rpcPermissionPattern } from "../../src/ui/lib/rpcPermission.ts";

test("an action gate admits exactly one in-flight UI action", () => {
  const gate = createActionGate();
  assert.equal(gate.tryEnter(), true);
  assert.equal(gate.tryEnter(), false);
  gate.leave();
  assert.equal(gate.tryEnter(), true);
});

test("review identity changes with account, RPC, amount, or slippage", () => {
  const initial = reviewKey([
    "0x0000000000000000000000000000000000000001",
    "litvm",
    "https://rpc.example/",
    1n,
    50,
  ]);
  assert.notEqual(initial, reviewKey([
    "0x0000000000000000000000000000000000000002",
    "litvm",
    "https://rpc.example/",
    1n,
    50,
  ]));
  assert.notEqual(initial, reviewKey([
    "0x0000000000000000000000000000000000000001",
    "litvm",
    "https://other.example/",
    1n,
    50,
  ]));
  assert.notEqual(initial, reviewKey([
    "0x0000000000000000000000000000000000000001",
    "litvm",
    "https://rpc.example/",
    2n,
    50,
  ]));
  assert.notEqual(initial, reviewKey([
    "0x0000000000000000000000000000000000000001",
    "litvm",
    "https://rpc.example/",
    1n,
    100,
  ]));
});

test("review identity keeps primitive types distinct", () => {
  assert.notEqual(reviewKey(["1"]), reviewKey([1]));
  assert.notEqual(reviewKey([1]), reviewKey([1n]));
  assert.notEqual(reviewKey([null]), reviewKey([undefined]));
});

test("amount input accepts decimal commas without joining invalid digit groups", () => {
  assert.equal(normalizeDecimalInput("1,5"), "1.5");
  assert.equal(normalizeDecimalInput(",25"), "0.25");
  assert.equal(normalizeDecimalInput(" 12.50 "), "12.50");
  assert.equal(normalizeDecimalInput("1e3"), "1e3");
  assert.equal(normalizeDecimalInput("1-2"), "1-2");
  assert.equal(normalizeDecimalInput("1,234.56"), "1,234.56");
  assert.equal(normalizeDecimalInput("1.2.3"), "1.2.3");
});

test("RPC host permissions preserve explicit ports and reject wildcard hosts", () => {
  assert.equal(
    rpcPermissionPattern("https://rpc.example.test:8545/path"),
    "https://rpc.example.test:8545/*",
  );
  assert.equal(rpcPermissionPattern("https://rpc.example.test:443/path"), "https://rpc.example.test/*");
  assert.equal(rpcPermissionPattern("http://localhost:8545"), "http://localhost:8545/*");
  assert.equal(rpcPermissionPattern("http://[::1]:8545"), "http://[::1]:8545/*");
  assert.equal(rpcPermissionPattern("https://*.example.test"), null);
  assert.equal(rpcPermissionPattern("ftp://rpc.example.test"), null);
  assert.equal(rpcPermissionPattern("not a url"), null);
});
