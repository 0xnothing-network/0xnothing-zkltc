import assert from "node:assert/strict";
import test from "node:test";
import { ContractFunctionExecutionError, ContractFunctionRevertedError, encodeErrorResult } from "viem";
import { readableError } from "../../features/fi/lib/errors.ts";

test("a custom-error revert names the error instead of only saying it reverted", () => {
  const abi = [{ type: "error", name: "InsufficientOutputAmount", inputs: [] }] as const;
  const reverted = new ContractFunctionRevertedError({
    abi,
    data: encodeErrorResult({ abi, errorName: "InsufficientOutputAmount" }),
    functionName: "swap",
  });
  const wrapped = new ContractFunctionExecutionError(reverted, { abi, functionName: "swap", args: [] });
  assert.equal(readableError(wrapped), "Contract reverted: InsufficientOutputAmount");
  assert.equal(readableError(new Error("User rejected the request.")), "The wallet request was rejected.");
});
