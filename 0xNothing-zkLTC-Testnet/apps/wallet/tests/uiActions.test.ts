import assert from "node:assert/strict";
import { test } from "node:test";
import { createActionGate } from "../src/ui/lib/actionGate.ts";
import { reviewKey } from "../src/ui/lib/reviewKey.ts";

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
