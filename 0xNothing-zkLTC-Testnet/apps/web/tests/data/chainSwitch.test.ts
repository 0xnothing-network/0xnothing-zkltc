import assert from "node:assert/strict";
import test from "node:test";
import { isLitvmChainId, LITVM_CHAIN_ID, requireLitvmChainId } from "../../lib/chainSwitch.ts";

test("LitVM LiteForge is the only accepted chain id", () => {
  assert.equal(LITVM_CHAIN_ID, 4441);
  assert.equal(isLitvmChainId(4441), true);
  assert.equal(isLitvmChainId(1), false);
  assert.equal(isLitvmChainId(undefined), false);
  assert.equal(isLitvmChainId(null), false);
});

test("requireLitvmChainId refuses to proceed on the wrong network", () => {
  assert.doesNotThrow(() => requireLitvmChainId(4441));
  assert.throws(() => requireLitvmChainId(1), /Wrong network/);
  assert.throws(() => requireLitvmChainId(undefined), /Wrong network/);
});
