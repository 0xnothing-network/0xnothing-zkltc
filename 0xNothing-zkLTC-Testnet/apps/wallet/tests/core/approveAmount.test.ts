import assert from "node:assert/strict";
import { test } from "node:test";
import { encodeFunctionData, erc20Abi, parseAbi } from "viem";
import {
  APPROVE_SELECTOR,
  INCREASE_ALLOWANCE_SELECTOR,
  isLoweredApprove,
  parseApproveCall,
  parseApproveCallLenient,
  rewriteApproveAmount,
} from "../../src/core/lib/approveAmount.ts";

const SPENDER = "0x1111111111111111111111111111111111111111";
const OTHER = "0x2222222222222222222222222222222222222222";
const MAX = 2n ** 256n - 1n;
const increaseAbi = parseAbi(["function increaseAllowance(address spender, uint256 added) returns (bool)"]);
const approveData = (spender: `0x${string}`, amount: bigint) =>
  encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [spender, amount] });
const increaseData = (spender: `0x${string}`, amount: bigint) =>
  encodeFunctionData({ abi: increaseAbi, functionName: "increaseAllowance", args: [spender, amount] });

test("accepts only approve and increaseAllowance at exactly 68 bytes", () => {
  const approve = approveData(SPENDER, 1000n * 10n ** 18n);
  assert.deepEqual(parseApproveCall(approve), { selector: APPROVE_SELECTOR, spender: SPENDER, amount: 1000n * 10n ** 18n });
  assert.deepEqual(parseApproveCall(increaseData(OTHER, MAX)), { selector: INCREASE_ALLOWANCE_SELECTOR, spender: OTHER, amount: MAX });
  // Upper-case hex, selector included, is the same call.
  assert.equal(parseApproveCall(`0x${approve.slice(2).toUpperCase()}`)?.amount, 1000n * 10n ** 18n);
  assert.equal(parseApproveCall(approve.slice(0, -2)), null, "67 bytes");
  assert.equal(parseApproveCall(`${approve}00`), null, "69 bytes");
  assert.equal(parseApproveCall(`${approve}${"00".repeat(32)}`), null, "100 bytes");
  assert.equal(parseApproveCall(encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [SPENDER, 5n] })), null);
  assert.equal(
    parseApproveCall(encodeFunctionData({ abi: erc20Abi, functionName: "transferFrom", args: [SPENDER, OTHER, 5n] })),
    null,
  );
  // The lenient form reads a record with trailing bytes, never a short one.
  assert.equal(parseApproveCallLenient(`${approve}00`)?.spender, SPENDER);
  assert.equal(parseApproveCallLenient(approve.slice(0, -2)), null);
});

test("a dirty spender word is refused", () => {
  const approve = approveData(SPENDER, 5n);
  const dirty = `${approve.slice(0, 10)}ff${approve.slice(12)}`;
  assert.equal(parseApproveCall(dirty), null);
  assert.equal(parseApproveCallLenient(dirty), null);
  assert.equal(rewriteApproveAmount(dirty, 1n), null);
});

test("the rewrite changes only the last 32-byte word", () => {
  const requested = 123_456_789n * 10n ** 18n;
  for (const data of [approveData(SPENDER, requested), increaseData(OTHER, requested)]) {
    for (const amount of [0n, 1n, 5n * 10n ** 18n, requested - 1n, requested / 3n]) {
      const out = rewriteApproveAmount(data, amount);
      assert.ok(out !== null);
      assert.equal(out.length, data.length);
      assert.equal(out.slice(0, 74), data.slice(0, 74));
      assert.equal(BigInt(`0x${out.slice(74)}`), amount);
      assert.equal(parseApproveCall(out)?.amount, amount);
    }
  }
  // 5e18, as the end-to-end check reads it at the end of the raw calldata.
  assert.ok(rewriteApproveAmount(approveData(SPENDER, 1000n * 10n ** 18n), 5n * 10n ** 18n)?.endsWith("4563918244f40000"));
});

test("the requested amount returns the very same string", () => {
  const data = `0x${approveData(SPENDER, MAX).slice(2).toUpperCase()}`;
  assert.equal(rewriteApproveAmount(data, MAX), data);
});

test("an amount above the requested one, a negative one or a non-bigint is refused", () => {
  const data = approveData(SPENDER, 1000n);
  assert.equal(rewriteApproveAmount(data, 1001n), null);
  assert.equal(rewriteApproveAmount(data, -1n), null);
  assert.equal(rewriteApproveAmount(data, 5), null);
  assert.equal(rewriteApproveAmount(data, "5"), null);
  assert.equal(rewriteApproveAmount(data, undefined), null);
});

test("never throws on any input", () => {
  const inputs: unknown[] = [
    null, undefined, 0, 1n, {}, [], "0x", "0x095ea7b3", "095ea7b3", `0x${"g".repeat(136)}`,
    `0x095ea7b3${"0".repeat(127)}`, `0x${"f".repeat(200_000)}`, Symbol("x"), () => 1,
  ];
  for (const input of inputs) {
    assert.doesNotThrow(() => parseApproveCall(input));
    assert.doesNotThrow(() => parseApproveCallLenient(input));
    assert.doesNotThrow(() => rewriteApproveAmount(input, 1n));
    assert.doesNotThrow(() => isLoweredApprove(input, input));
    assert.equal(parseApproveCall(input), null);
  }
});

test("isLoweredApprove refuses another spender, another selector, a higher amount", () => {
  const original = approveData(SPENDER, 1000n);
  assert.equal(isLoweredApprove(original, approveData(SPENDER, 999n)), true);
  assert.equal(isLoweredApprove(original, original), true);
  assert.equal(isLoweredApprove(original, approveData(SPENDER, 0n)), true);
  assert.equal(isLoweredApprove(original, approveData(SPENDER, 1001n)), false);
  assert.equal(isLoweredApprove(original, approveData(OTHER, 1n)), false);
  assert.equal(isLoweredApprove(original, increaseData(SPENDER, 1n)), false);
  assert.equal(isLoweredApprove(original, `${approveData(SPENDER, 1n)}00`), false);
  // The prefix must match byte for byte, hex case included.
  assert.equal(isLoweredApprove(original, `0x${approveData(SPENDER, 1n).slice(2).toUpperCase()}`), false);
  assert.equal(isLoweredApprove(`${original}00`, approveData(SPENDER, 1n)), false);
});

test("the ERC-165 answer keeps the editor off for an NFT or an unknown contract", async () => {
  const { nftFromProbe } = await import("../../src/core/lib/approveAmount.ts");
  const { ContractFunctionExecutionError, ContractFunctionRevertedError, ContractFunctionZeroDataError, AbiDecodingZeroDataError, HttpRequestError, TimeoutError, RpcRequestError, CallExecutionError } = await import("viem");
  assert.equal(nftFromProbe({ answer: true }), true);
  assert.equal(nftFromProbe({ answer: false }), false);
  assert.equal(nftFromProbe({ answer: "0x01" }), null);
  const wrap = (cause: Error) => new ContractFunctionExecutionError(cause as never, { abi: [], functionName: "supportsInterface" });
  // No such function: a revert, or no data at all.
  assert.equal(nftFromProbe({ error: wrap(new ContractFunctionRevertedError({ abi: [], functionName: "supportsInterface" })) }), false);
  assert.equal(nftFromProbe({ error: wrap(new ContractFunctionZeroDataError({ functionName: "supportsInterface" })) }), false);
  assert.equal(nftFromProbe({ error: new AbiDecodingZeroDataError() }), false);
  // geth's plain -32000 "execution reverted", which viem leaves unclassified.
  const plainRevert = new RpcRequestError({ body: {}, error: { code: -32000, message: "execution reverted" }, url: "https://rpc.example" });
  assert.equal(nftFromProbe({ error: wrap(new CallExecutionError(plainRevert, { account: undefined } as never)) }), false);
  // The RPC could not answer: unknown.
  assert.equal(nftFromProbe({ error: wrap(new HttpRequestError({ url: "https://rpc.example", status: 503 })) }), null);
  assert.equal(nftFromProbe({ error: wrap(new TimeoutError({ body: {}, url: "https://rpc.example" })) }), null);
  assert.equal(nftFromProbe({ error: new Error("offline") }), null);
  assert.equal(nftFromProbe({ error: null }), null);
  const loop: { cause?: unknown } = {};
  loop.cause = loop;
  assert.equal(nftFromProbe({ error: loop }), null);
});
