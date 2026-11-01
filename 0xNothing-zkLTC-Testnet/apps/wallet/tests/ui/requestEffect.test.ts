import assert from "node:assert/strict";
import { test } from "node:test";
import { encodeFunctionData, getAddress, maxUint256, parseAbi } from "viem";
import {
  callEffect,
  deadlineDate,
  effectTokens,
  typedEffect,
  UNLIMITED,
} from "../../src/ui/lib/requestEffect.ts";

const TOKEN = getAddress("0x1111111111111111111111111111111111111111");
const OTHER = getAddress("0x2222222222222222222222222222222222222222");
const SPENDER = getAddress("0x3333333333333333333333333333333333333333");
const OWNER = getAddress("0x4444444444444444444444444444444444444444");
const PERMIT2 = getAddress("0x000000000022d473030f116ddee9f6b43ac78ba3");

const ABI = parseAbi([
  "function transfer(address to, uint256 amount)",
  "function approve(address spender, uint256 amount)",
  "function increaseAllowance(address spender, uint256 addedValue)",
  "function transferFrom(address from, address to, uint256 amount)",
  "function safeTransferFrom(address from, address to, uint256 tokenId)",
  "function safeTransferFrom(address from, address to, uint256 tokenId, bytes data)",
  "function setApprovalForAll(address operator, bool approved)",
  "function mint(uint256 amount)",
]);

function typed(primaryType: string, message: Record<string, unknown>, verifyingContract: string = TOKEN): string {
  return JSON.stringify({ domain: { name: "Token", chainId: 4441, verifyingContract }, primaryType, message });
}

test("token calls name the counterparty and the amount", () => {
  const lower = TOKEN.toLowerCase();
  assert.deepEqual(
    callEffect(lower, encodeFunctionData({ abi: ABI, functionName: "transfer", args: [SPENDER, 5n] })),
    { kind: "transfer", token: TOKEN, from: null, to: SPENDER, amount: 5n },
  );
  assert.deepEqual(
    callEffect(TOKEN, encodeFunctionData({ abi: ABI, functionName: "transferFrom", args: [OWNER, SPENDER, 7n] })),
    { kind: "transfer", token: TOKEN, from: OWNER, to: SPENDER, amount: 7n },
  );
  for (const functionName of ["approve", "increaseAllowance"] as const) {
    assert.deepEqual(
      callEffect(TOKEN, encodeFunctionData({ abi: ABI, functionName, args: [SPENDER, maxUint256] })),
      { kind: "approve", spender: SPENDER, grants: [{ token: TOKEN, amount: maxUint256 }], signed: false, validUntil: null },
    );
  }
  assert.deepEqual(
    callEffect(TOKEN, encodeFunctionData({ abi: ABI, functionName: "setApprovalForAll", args: [SPENDER, true] })),
    { kind: "approve-all", operator: SPENDER, approved: true },
  );
});

test("both ERC-721 safeTransferFrom overloads decode to the same transfer", () => {
  const expected = { kind: "nft-transfer", from: OWNER, to: SPENDER, tokenId: 42n };
  assert.deepEqual(
    callEffect(TOKEN, encodeFunctionData({ abi: ABI, functionName: "safeTransferFrom", args: [OWNER, SPENDER, 42n] })),
    expected,
  );
  assert.deepEqual(
    callEffect(TOKEN, encodeFunctionData({ abi: ABI, functionName: "safeTransferFrom", args: [OWNER, SPENDER, 42n, "0xbeef"] })),
    expected,
  );
});

test("unknown, truncated or targetless calldata stays raw", () => {
  const approve = encodeFunctionData({ abi: ABI, functionName: "approve", args: [SPENDER, 1n] });
  assert.equal(callEffect(TOKEN, encodeFunctionData({ abi: ABI, functionName: "mint", args: [1n] })), null);
  assert.equal(callEffect(TOKEN, approve.slice(0, 40)), null);
  assert.equal(callEffect(undefined, approve), null);
  assert.equal(callEffect("not-an-address", approve), null);
  assert.equal(callEffect(TOKEN, "approve"), null);
  assert.equal(callEffect(TOKEN, undefined), null);
});

test("EIP-2612 and DAI permits name the spender, the allowance and the deadline", () => {
  for (const value of [5, "5", "0x5"]) {
    assert.deepEqual(
      typedEffect(typed("Permit", { owner: OWNER, spender: SPENDER, value, nonce: 0, deadline: "1700000000" })),
      { kind: "approve", spender: SPENDER, grants: [{ token: TOKEN, amount: 5n }], signed: true, validUntil: 1_700_000_000n },
    );
  }
  assert.deepEqual(
    typedEffect(typed("Permit", { holder: OWNER, spender: SPENDER, nonce: 0, expiry: 0, allowed: true })),
    { kind: "approve", spender: SPENDER, grants: [{ token: TOKEN, amount: maxUint256 }], signed: true, validUntil: null },
  );
  assert.deepEqual(
    typedEffect(typed("Permit", { holder: OWNER, spender: SPENDER, nonce: 0, expiry: 9, allowed: false })),
    { kind: "approve", spender: SPENDER, grants: [{ token: TOKEN, amount: 0n }], signed: true, validUntil: 9n },
  );
});

test("Permit2 allowance and transfer signatures list every token they reach", () => {
  const details = (token: string, expiration: number) => ({ token, amount: "100", expiration, nonce: 0 });
  assert.deepEqual(
    typedEffect(typed("PermitSingle", { details: details(TOKEN, 50), spender: SPENDER, sigDeadline: 10 }, PERMIT2)),
    { kind: "approve", spender: SPENDER, grants: [{ token: TOKEN, amount: 100n }], signed: true, validUntil: 50n },
  );
  assert.deepEqual(
    typedEffect(typed("PermitBatch", {
      details: [details(TOKEN, 50), details(OTHER, 90)],
      spender: SPENDER,
      sigDeadline: 10,
    }, PERMIT2)),
    {
      kind: "approve",
      spender: SPENDER,
      grants: [{ token: TOKEN, amount: 100n }, { token: OTHER, amount: 100n }],
      signed: true,
      validUntil: 90n,
    },
  );
  for (const primaryType of ["PermitTransferFrom", "PermitWitnessTransferFrom"]) {
    assert.deepEqual(
      typedEffect(typed(primaryType, {
        permitted: { token: OTHER, amount: "7" },
        spender: SPENDER,
        nonce: 1,
        deadline: 60,
        witness: { anything: true },
      }, PERMIT2)),
      { kind: "approve", spender: SPENDER, grants: [{ token: OTHER, amount: 7n }], signed: true, validUntil: 60n },
    );
  }
  assert.deepEqual(
    typedEffect(typed("PermitBatchTransferFrom", {
      permitted: [{ token: TOKEN, amount: 1 }, { token: OTHER, amount: 2 }],
      spender: SPENDER,
      nonce: 1,
      deadline: 60,
    }, PERMIT2))?.kind,
    "approve",
  );
});

test("typed data that is not a well-formed permit stays raw", () => {
  const good = { owner: OWNER, spender: SPENDER, value: 1, nonce: 0, deadline: 1 };
  for (const message of [
    "not json",
    JSON.stringify(null),
    JSON.stringify({ primaryType: "Permit" }),
    typed("Mail", { spender: SPENDER, contents: "hi" }),
    typed("Permit", { ...good, spender: "nobody" }),
    typed("Permit", { ...good, value: -1 }),
    typed("Permit", { ...good, value: 1.5 }),
    typed("Permit", { ...good, value: Number.MAX_SAFE_INTEGER + 2 }),
    typed("Permit", { ...good, value: (maxUint256 + 1n).toString() }),
    typed("Permit", { ...good, value: "12abc" }),
    typed("Permit", good, "not-a-contract"),
    typed("Permit", { holder: OWNER, spender: SPENDER, nonce: 0, expiry: 0, allowed: "yes" }),
    typed("PermitSingle", { details: [{ token: TOKEN, amount: 1, expiration: 1, nonce: 0 }], spender: SPENDER }),
    typed("PermitBatch", { details: [], spender: SPENDER }),
    typed("PermitTransferFrom", { permitted: { token: TOKEN, amount: 1 }, spender: SPENDER, nonce: 0 }),
  ]) {
    assert.equal(typedEffect(message), null, message);
  }
});

test("token reads are deduplicated and an unlimited grant is unmistakable", () => {
  assert.deepEqual(effectTokens(typedEffect(typed("PermitBatch", {
    details: [TOKEN, OTHER, TOKEN].map((token) => ({ token, amount: 1, expiration: 1, nonce: 0 })),
    spender: SPENDER,
    sigDeadline: 1,
  }))), [TOKEN, OTHER]);
  assert.deepEqual(effectTokens({ kind: "approve-all", operator: SPENDER, approved: true }), []);
  assert.deepEqual(effectTokens(null), []);
  assert.ok(maxUint256 >= UNLIMITED);
  assert.ok(2n ** 160n - 1n >= UNLIMITED);
  assert.ok(10n ** 36n < UNLIMITED);
});

test("deadlines render as a local minute, and the far future as no expiry", () => {
  const seconds = 1_700_000_000n;
  const date = new Date(Number(seconds) * 1000);
  const pad = (part: number) => part.toString().padStart(2, "0");
  assert.equal(
    deadlineDate(seconds),
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`,
  );
  assert.equal(deadlineDate(null), null);
  assert.equal(deadlineDate(2n ** 48n - 1n), null);
  assert.equal(deadlineDate(maxUint256), null);
});
