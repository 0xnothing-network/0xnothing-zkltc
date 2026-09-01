import assert from "node:assert/strict";
import { test } from "node:test";
import { createRpcIngressGate } from "../../src/extension/rpcIngress.ts";

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
