import assert from "node:assert/strict";
import test from "node:test";
import type { Hash, ReplacementReturnType, WaitForTransactionReceiptParameters } from "viem";
import { ReceiptConfirmationError, waitForProtocolReceipt } from "../../lib/transactionReceipt.ts";

const ORIGINAL: Hash = `0x${"a".repeat(64)}`;
const REPLACEMENT: Hash = `0x${"b".repeat(64)}`;

function client(options: { reason?: "cancelled" | "replaced" | "repriced"; reverted?: boolean; unannounced?: boolean } = {}) {
  const receipt = {
    transactionHash: options.reason || options.unannounced ? REPLACEMENT : ORIGINAL,
    status: options.reverted ? "reverted" as const : "success" as const,
    logs: [],
  };
  return {
    waitForTransactionReceipt: async (parameters: WaitForTransactionReceiptParameters) => {
      assert.equal(parameters.hash, ORIGINAL);
      assert.equal(parameters.checkReplacement, true);
      if (options.reason) parameters.onReplaced?.({
        reason: options.reason,
        transactionReceipt: receipt,
      } as unknown as ReplacementReturnType);
      return receipt;
    },
  };
}

test("the requested successful receipt preserves its full data", async () => {
  const receipt = await waitForProtocolReceipt(client(), ORIGINAL);
  assert.equal(receipt.transactionHash, ORIGINAL);
  assert.deepEqual(receipt.logs, []);
});

test("a speed-up confirms the same action under the actual mined hash", async () => {
  const receipt = await waitForProtocolReceipt(client({ reason: "repriced" }), ORIGINAL);
  assert.equal(receipt.transactionHash, REPLACEMENT);
});

test("successful cancellations and different actions cannot be reported as protocol success", async () => {
  for (const reason of ["cancelled", "replaced"] as const) {
    await assert.rejects(waitForProtocolReceipt(client({ reason }), ORIGINAL), (error: unknown) => {
      assert.ok(error instanceof ReceiptConfirmationError);
      assert.equal(error.reason, reason);
      assert.equal(error.hash, REPLACEMENT);
      return true;
    });
  }
});

test("a reverted requested action or speed-up retains the mined hash", async () => {
  for (const reason of [undefined, "repriced"] as const) {
    await assert.rejects(waitForProtocolReceipt(client({ reason, reverted: true }), ORIGINAL), (error: unknown) => {
      assert.ok(error instanceof ReceiptConfirmationError);
      assert.equal(error.reason, "reverted");
      assert.equal(error.hash, reason ? REPLACEMENT : ORIGINAL);
      return true;
    });
  }
});

test("an unexpected receipt without verified replacement intent cannot succeed", async () => {
  await assert.rejects(waitForProtocolReceipt(client({ unannounced: true }), ORIGINAL), (error: unknown) => {
    assert.ok(error instanceof ReceiptConfirmationError);
    assert.equal(error.reason, "unverified");
    return true;
  });
});

test("RPC failures preserve the original error", async () => {
  const rpcError = new Error("RPC unavailable");
  await assert.rejects(waitForProtocolReceipt({
    waitForTransactionReceipt: async () => { throw rpcError; },
  }, ORIGINAL), (error) => error === rpcError);
});

test("speeding up a cancellation or changed action cannot restore the original intent", async () => {
  for (const reason of ["cancelled", "replaced"] as const) {
    await assert.rejects(waitForProtocolReceipt({
      waitForTransactionReceipt: async (parameters: WaitForTransactionReceiptParameters) => {
        const receipt = { transactionHash: REPLACEMENT, status: "success" as const };
        for (const replacementReason of [reason, "repriced"] as const) {
          parameters.onReplaced?.({ reason: replacementReason, transactionReceipt: receipt } as unknown as ReplacementReturnType);
        }
        return receipt;
      },
    }, ORIGINAL), (error: unknown) => {
      assert.ok(error instanceof ReceiptConfirmationError);
      assert.equal(error.reason, reason);
      assert.equal(error.hash, REPLACEMENT);
      return true;
    });
  }
});
