import assert from "node:assert/strict";
import test from "node:test";
import { ReceiptConfirmationError } from "../../lib/transactionReceipt.ts";
import { evaluateModule } from "../helpers/evaluateModule.ts";

const requestedHash = `0x${"1".repeat(64)}`;
const replacementHash = `0x${"2".repeat(64)}`;

function harness() {
  let state: unknown;
  let parameters: { hash?: string; checkReplacement?: boolean; onReplaced: (value: unknown) => void };
  let receipt: { status: string; transactionHash: string } | undefined;
  const { useProtocolReceipt } = evaluateModule<{
    useProtocolReceipt: (value: { hash?: string; chainId: number }) => {
      data?: unknown; error?: ReceiptConfirmationError; isSuccess: boolean; isError: boolean; isLoading: boolean;
    };
  }>(new URL("../../lib/useProtocolReceipt.ts", import.meta.url), {
    react: {
      useState: () => [state, (next: (previous: unknown) => unknown) => { state = next(state); }],
    },
    wagmi: {
      useWaitForTransactionReceipt: (options: typeof parameters) => {
        parameters = options;
        return { data: receipt, isSuccess: !!receipt, isError: false, isLoading: !receipt };
      },
    },
    "@/lib/transactionReceipt": { ReceiptConfirmationError },
  });
  return {
    render: function ReceiptHarness(hash: string | undefined = requestedHash) {
      return useProtocolReceipt({ chainId: 4441, hash });
    },
    confirm: (hash = requestedHash) => { receipt = { status: "success", transactionHash: hash }; },
    replace: (reason: string, hash = replacementHash) => parameters.onReplaced({
      reason, transactionReceipt: { transactionHash: hash },
    }),
    parameters: () => parameters,
  };
}

for (const reason of ["cancelled", "replaced"] as const) {
  test(`Pixel receipt hook refuses successful ${reason} receipts`, () => {
    const scenario = harness();
    scenario.render();
    scenario.replace(reason);
    scenario.confirm(replacementHash);
    const result = scenario.render();
    assert.equal(result.data, undefined, "no component can treat the replacement as its successful action");
    assert.equal(result.isSuccess, false);
    assert.equal(result.isError, true);
    assert.equal(result.isLoading, false);
    assert.equal(result.error?.reason, reason);
    assert.equal(result.error?.hash, replacementHash);
  });
}

test("Pixel receipt hook keeps normal confirmations and wallet speed-ups usable", () => {
  const scenario = harness();
  scenario.render();
  assert.equal(scenario.parameters().checkReplacement, true);
  scenario.confirm();
  assert.equal(scenario.render().isSuccess, true);
  scenario.replace("repriced");
  scenario.confirm(replacementHash);
  assert.equal(scenario.render().isSuccess, true);
  assert.equal(scenario.render().error, undefined);
});

test("a sped-up wallet cancellation never restores the original Pixel action", () => {
  const scenario = harness();
  scenario.render();
  scenario.replace("cancelled");
  scenario.replace("repriced", `0x${"3".repeat(64)}`);
  scenario.confirm(`0x${"3".repeat(64)}`);
  assert.equal(scenario.render().error?.reason, "cancelled");
  assert.equal(scenario.render().error?.hash, `0x${"3".repeat(64)}`);
});

test("changing the submitted hash isolates a previous cancellation", () => {
  const scenario = harness();
  scenario.render();
  scenario.replace("cancelled");
  scenario.confirm(replacementHash);
  const nextHash = `0x${"4".repeat(64)}`;
  scenario.confirm(nextHash);
  assert.equal(scenario.render(nextHash).isSuccess, true);
  assert.equal(scenario.render(nextHash).error, undefined);
});

test("an unexplained cached replacement cannot confirm a Pixel action", () => {
  const scenario = harness();
  scenario.confirm(replacementHash);
  const result = scenario.render();
  assert.equal(result.data, undefined);
  assert.equal(result.error?.reason, "unverified");
});
