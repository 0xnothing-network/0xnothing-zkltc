import assert from "node:assert/strict";
import test from "node:test";
import { deliveredTokenAmount } from "../../../../shared/transactions/tokenDelivery.ts";

const token = `0x${"11".repeat(20)}`;
const account = `0x${"22".repeat(20)}`;
const other = `0x${"33".repeat(20)}`;
const topic = (address: string) => `0x${address.slice(2).padStart(64, "0")}`;
const transfer = (from: string, to: string, amount: bigint, address = token) => ({
  address,
  topics: ["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef", topic(from), topic(to)],
  data: `0x${amount.toString(16).padStart(64, "0")}`,
});

test("delivery sums receipt inflows minus outflows, ignoring other tokens, accounts and self-transfers", () => {
  const receipt = { status: "success", logs: [
    transfer(other, account, 100n), transfer(other, account, 30n), transfer(account, other, 20n),
    transfer(account, account, 900n), transfer(other, account, 5_000n, other), transfer(other, other, 8_000n),
  ] };
  assert.equal(deliveredTokenAmount(receipt, token.toUpperCase().replace("0X", "0x"), account), 110n);
});

test("mint events and uint256-scale quantities retain full precision", () => {
  const amount = 2n ** 255n + 12345n;
  assert.equal(deliveredTokenAmount({ status: "success", logs: [transfer(`0x${"00".repeat(20)}`, account, amount)] }, token, account), amount);
});

test("failed receipts and missing or nonpositive net delivery cannot advance a staged swap", () => {
  for (const receipt of [
    { status: "reverted", logs: [transfer(other, account, 50n)] },
    { status: "success", logs: [] },
    { status: "success", logs: [transfer(account, other, 50n)] },
    { status: "success", logs: [transfer(other, account, 50n), transfer(account, other, 50n)] },
  ]) assert.throws(() => deliveredTokenAmount(receipt, token, account));
});

test("malformed ERC-20 logs fail closed, including ERC-721-shaped transfers", () => {
  const valid = transfer(other, account, 50n);
  for (const log of [
    { ...valid, topics: [...valid.topics, topic(token)] },
    { ...valid, topics: [valid.topics[0], "0x12", topic(account)] },
    { ...valid, data: "0x12" },
    { ...valid, removed: true },
  ]) assert.throws(() => deliveredTokenAmount({ status: "success", logs: [log] }, token, account), /Invalid token delivery log/);
});
