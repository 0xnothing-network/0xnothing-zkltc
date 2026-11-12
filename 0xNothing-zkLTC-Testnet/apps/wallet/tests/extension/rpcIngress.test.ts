import assert from "node:assert/strict";
import { test } from "node:test";
import { createRpcIngressGate, createRpcSlotQueue } from "../../src/extension/rpcIngress.ts";

test("provider ingress caps one origin without starving another", () => {
  const gate = createRpcIngressGate({ maxGlobal: 3, maxPerOrigin: 2 });
  const first = gate.tryAcquire("https://one.example");
  const second = gate.tryAcquire("https://one.example");
  assert.ok(first);
  assert.ok(second);
  assert.equal(gate.tryAcquire("https://one.example"), null);

  const other = gate.tryAcquire("https://two.example");
  assert.ok(other);
  assert.equal(gate.tryAcquire("https://three.example"), null);
  assert.deepEqual(gate.active(), { global: 3, origins: 2 });

  first();
  first(); // Releases are idempotent even when used from a defensive finally.
  const third = gate.tryAcquire("https://three.example");
  assert.ok(third);
  assert.deepEqual(gate.active(), { global: 3, origins: 3 });

  second();
  other();
  third();
  assert.deepEqual(gate.active(), { global: 0, origins: 0 });
});

test("invalid provider ingress limits fail closed", () => {
  assert.throws(() => createRpcIngressGate({ maxGlobal: 0, maxPerOrigin: 1 }));
  assert.throws(() => createRpcIngressGate({ maxGlobal: 2, maxPerOrigin: 3 }));
});

test("a slot queue runs a fixed number at once, hands slots on in order and refuses a full line", async () => {
  const queue = createRpcSlotQueue({ maxInFlight: 2, maxWaiting: 1 });
  assert.equal(await queue.acquire(), true);
  assert.equal(await queue.acquire(), true);
  let waiterHoldsSlot = false;
  const waiting = queue.acquire().then((held) => { waiterHoldsSlot = held; });
  // The line behind the two slots holds one; the next caller is turned away at once.
  assert.equal(await queue.acquire(), false);
  await Promise.resolve();
  assert.equal(waiterHoldsSlot, false);

  queue.release();
  await waiting;
  assert.equal(waiterHoldsSlot, true);
  // The released slot went to the waiter, so both are still taken.
  const blocked = queue.acquire();
  assert.equal(await queue.acquire(), false);
  queue.release();
  assert.equal(await blocked, true);
  queue.release();
  queue.release();
  queue.release(); // An extra release cannot push the count below zero.
  assert.equal(await queue.acquire(), true);
  assert.equal(await queue.acquire(), true);
  assert.throws(() => createRpcSlotQueue({ maxInFlight: 0, maxWaiting: 1 }));
});
