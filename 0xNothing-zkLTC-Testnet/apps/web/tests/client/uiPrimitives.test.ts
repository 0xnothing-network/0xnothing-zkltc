import assert from "node:assert/strict";
import test from "node:test";
import {
  dropToLiquidation,
  healthBand,
  healthFactor,
  healthFactorFromLtv,
  liquidationPrice,
  safeMaxBorrow,
} from "../../lib/risk.ts";
import { resolveAction } from "../../lib/ui/actionState.ts";
import { impactNeedsConfirmation, impactTone } from "../../lib/ui/priceImpact.ts";

test("healthFactor follows threshold / LTV and is null without debt", () => {
  assert.equal(healthFactor(1_000, 0, 9_000), null);
  assert.equal(healthFactor(0, 10, 9_000), 0);
  // collateral 1000, threshold 90%, debt 450 → LTV 45% → HF 2
  assert.equal(healthFactor(1_000, 450, 9_000), 2);
  assert.equal(healthFactorFromLtv(4_500, 9_000), 2);
  assert.equal(healthFactorFromLtv(0, 9_000), null);
});

test("liquidationPrice solves for the collateral price that makes HF 1", () => {
  // 10 units collateral, debt 450, threshold 90% → price 50
  assert.equal(liquidationPrice(450, 10, 9_000), 50);
  assert.equal(liquidationPrice(0, 10, 9_000), null);
  assert.equal(liquidationPrice(450, 0, 9_000), null);
});

test("safeMaxBorrow stops at target HF and max LTV and never goes negative", () => {
  // threshold 90%: HF 1.5 limit = 600; max LTV 75% = 750 → 600 total
  assert.equal(safeMaxBorrow(1_000, 0, 9_000, 7_500), 600);
  assert.equal(safeMaxBorrow(1_000, 100, 9_000, 7_500), 500);
  // max LTV tighter than HF target
  assert.equal(safeMaxBorrow(1_000, 0, 9_000, 5_000), 500);
  assert.equal(safeMaxBorrow(1_000, 900, 9_000, 7_500), 0);
});

test("health bands match the spec thresholds", () => {
  assert.equal(healthBand(null), "none");
  assert.equal(healthBand(2), "safe");
  assert.equal(healthBand(1.99), "caution");
  assert.equal(healthBand(1.5), "caution");
  assert.equal(healthBand(1.49), "risk");
  assert.equal(healthBand(1.25), "risk");
  assert.equal(healthBand(1.1), "danger");
  assert.equal(healthBand(0.99), "liquidatable");
  assert.equal(dropToLiquidation(2), 0.5);
  assert.equal(dropToLiquidation(0.8), 0);
  assert.equal(dropToLiquidation(null), null);
});

test("resolveAction walks the CTA ladder in spec order", () => {
  const base = { verb: "Buy", isConnected: true, wrongNetwork: false };
  assert.equal(resolveAction({ ...base, isConnected: false, wrongNetwork: true }).label, "Connect wallet");
  assert.deepEqual(resolveAction({ ...base, wrongNetwork: true, needsAmount: true }), { kind: "switch", label: "Switch to LiteForge", disabled: false });
  assert.equal(resolveAction({ ...base, needsAmount: true, insufficient: "NUSD" }).label, "Enter amount");
  assert.equal(resolveAction({ ...base, insufficient: "NUSD", approve: "NUSD" }).label, "Insufficient NUSD");
  assert.equal(resolveAction({ ...base, quoteLoading: true, approve: "NUSD" }).label, "Getting quote…");
  assert.deepEqual(resolveAction({ ...base, approve: "NUSD" }), { kind: "approve", label: "Approve NUSD", disabled: false });
  assert.deepEqual(resolveAction(base), { kind: "submit", label: "Buy", disabled: false });
  assert.equal(resolveAction({ ...base, blockedReason: "Waiting for fresh price" }).disabled, true);
  assert.equal(resolveAction({ ...base, isConnected: false, phase: "signing" }).label, "Confirm in wallet…");
  assert.equal(resolveAction({ ...base, phase: "confirming" }).label, "Confirming…");
});

test("price impact ladder uses 1 / 3 / 5 percent breakpoints", () => {
  assert.equal(impactTone(0.4), "low");
  assert.equal(impactTone(1), "medium");
  assert.equal(impactTone(3), "high");
  assert.equal(impactTone(-5), "severe");
  assert.equal(impactTone(Number.NaN), "severe");
  assert.equal(impactNeedsConfirmation(4.99), false);
  assert.equal(impactNeedsConfirmation(5), true);
});
