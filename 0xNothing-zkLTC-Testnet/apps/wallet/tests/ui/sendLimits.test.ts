import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { evaluateModule } from "../../../web/tests/helpers/evaluateModule.ts";
import * as swapMath from "../../src/core/lib/swapMath.ts";

type Limits = { over: boolean; shortOnGas: boolean };
const evaluated = evaluateModule<{
  sendLimits(input: { native: boolean; parsed: bigint | null; balance: bigint | null; nativeBalance: bigint | null; feeWei: bigint | null }): Limits;
  sendMax(balance: bigint, native: boolean, decimals: number, feeWei: bigint | null): { amount: bigint; refine: boolean };
}>(new URL("../../src/ui/lib/sendLimits.ts", import.meta.url), { "../../core/lib/swapMath": swapMath });
// Copied out of the module's realm so deepEqual compares plain objects.
const sendLimits = (input: Parameters<typeof evaluated.sendLimits>[0]): Limits => ({ ...evaluated.sendLimits(input) });
const sendMax = (...args: Parameters<typeof evaluated.sendMax>) => ({ ...evaluated.sendMax(...args) });

const COIN = 10n ** 18n;
// A LiteForge native send: 25,200 gas at about 1.2e7 wei.
const FEE = 302_400_000_000n;

test("Send accepts the gas coin up to balance minus twice the fee", () => {
  const balance = COIN / 100n; // exactly the old 0.01 reserve
  const parsed = balance - 2n * FEE;
  assert.deepEqual(
    sendLimits({ native: true, parsed, balance, nativeBalance: balance, feeWei: FEE }),
    { over: false, shortOnGas: false },
  );
});

test("Send flags a gas-coin amount that leaves less than the fee", () => {
  const balance = 9n * COIN / 1000n;
  const parsed = balance - FEE / 2n;
  assert.deepEqual(
    sendLimits({ native: true, parsed, balance, nativeBalance: balance, feeWei: FEE }),
    { over: false, shortOnGas: true },
  );
});

test("Send's over-balance is the balance itself, for every token", () => {
  assert.equal(sendLimits({ native: true, parsed: 11n, balance: 10n, nativeBalance: 10n, feeWei: null }).over, true);
  assert.equal(sendLimits({ native: true, parsed: 10n, balance: 10n, nativeBalance: 10n, feeWei: null }).over, false);
  assert.equal(sendLimits({ native: false, parsed: 10n, balance: 10n, nativeBalance: 0n, feeWei: null }).over, false);
  assert.equal(sendLimits({ native: false, parsed: 11n, balance: 10n, nativeBalance: 0n, feeWei: null }).over, true);
  assert.equal(sendLimits({ native: true, parsed: null, balance: 10n, nativeBalance: 10n, feeWei: null }).over, false);
});

test("a token send is short on gas only when the fee exceeds the gas coin", () => {
  assert.equal(sendLimits({ native: false, parsed: 5n, balance: 5n, nativeBalance: FEE, feeWei: FEE }).shortOnGas, false);
  assert.equal(sendLimits({ native: false, parsed: 5n, balance: 5n, nativeBalance: FEE - 1n, feeWei: FEE }).shortOnGas, true);
  assert.equal(sendLimits({ native: false, parsed: 5n, balance: 5n, nativeBalance: null, feeWei: FEE }).shortOnGas, false);
});

test("MAX keeps twice the quoted fee on the gas coin and fills a token whole", () => {
  const balance = 9n * COIN / 1000n;
  assert.deepEqual(sendMax(balance, true, 18, FEE), { amount: balance - 2n * FEE, refine: false });
  assert.deepEqual(sendMax(balance, false, 18, FEE), { amount: balance, refine: false });
  assert.deepEqual(sendMax(FEE, true, 18, FEE), { amount: 0n, refine: false });
});

test("MAX before a quote uses the decimals-scaled reserve and asks to refine", () => {
  assert.deepEqual(sendMax(COIN, true, 18, null), { amount: COIN - COIN / 100n, refine: true });
  // A 6-decimal coin keeps 0.01 coin back, not 10,000 coins.
  assert.deepEqual(sendMax(5_000_000n, true, 6, null), { amount: 4_990_000n, refine: true });
  // Below the fallback, the whole balance is filled so a quote can run.
  assert.deepEqual(sendMax(COIN / 1000n, true, 18, null), { amount: COIN / 1000n, refine: true });
  assert.deepEqual(sendMax(0n, true, 18, null), { amount: 0n, refine: false });
});

test("Send uses the plain balance rule, the fee formatter and no fixed reserve", () => {
  const send = readFileSync(new URL("../../src/ui/screens/Send.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(send, /NATIVE_GAS_RESERVE_WEI|spendableForSwap/u);
  assert.doesNotMatch(send, /formatAmount\(\s*(?:feeWei|reviewFeeWei)/u);
  assert.equal(send.match(/formatFee\((?:feeWei|reviewFeeWei), nativeToken\.decimals\)/gu)?.length, 3);
  assert.match(send, /sendMax\(balance, native, token\.decimals, feeWei\)/u);
});
