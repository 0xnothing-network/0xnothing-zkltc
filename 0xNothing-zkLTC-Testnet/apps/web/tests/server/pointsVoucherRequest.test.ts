import assert from "node:assert/strict";
import test from "node:test";
import { maxUint256 } from "viem";
import {
  isJsonContentType,
  parseVoucherRequestBody,
} from "../../app/api/dev/points/voucher/request.ts";

const CHAIN_ID = 4441;
const validRequest = {
  domain: "127.0.0.1:3000",
  admin: "0x1111111111111111111111111111111111111111",
  contract: "0x2222222222222222222222222222222222222222",
  chainId: CHAIN_ID,
  account: "0x3333333333333333333333333333333333333333",
  recipient: "0x4444444444444444444444444444444444444444",
  pointCredits: "1",
  nonce: "0",
  deadline: "2000000300",
  rateVersion: "3",
  issuedAt: "2033-05-18T03:33:20.000Z",
  requestNonce: "1234567890abcdef1234567890abcdef",
  message: "signed message",
  signature: `0x${"11".repeat(65)}`,
};

test("voucher requests accept only the exact JSON media type", () => {
  assert.equal(isJsonContentType("application/json"), true);
  assert.equal(isJsonContentType("Application/JSON; Charset=UTF-8"), true);
  assert.equal(isJsonContentType(" application/json ; charset=utf-8"), true);
  assert.equal(isJsonContentType("application/jsonp"), false);
  assert.equal(isJsonContentType("text/json"), false);
  assert.equal(isJsonContentType(null), false);
});

test("voucher request parsing binds the configured chain and normalizes addresses", () => {
  const parsed = parseVoucherRequestBody(validRequest, CHAIN_ID);
  assert.ok(parsed);
  assert.equal(parsed.chainId, CHAIN_ID);
  assert.equal(parsed.account, validRequest.account);
  assert.equal(parseVoucherRequestBody({ ...validRequest, chainId: CHAIN_ID + 1 }, CHAIN_ID), undefined);
});

test("voucher request parsing rejects integers outside uint256", () => {
  assert.ok(parseVoucherRequestBody({
    ...validRequest,
    pointCredits: maxUint256.toString(),
  }, CHAIN_ID));
  assert.equal(parseVoucherRequestBody({
    ...validRequest,
    pointCredits: (maxUint256 + 1n).toString(),
  }, CHAIN_ID), undefined);
  assert.equal(parseVoucherRequestBody({
    ...validRequest,
    deadline: (maxUint256 + 1n).toString(),
  }, CHAIN_ID), undefined);
});
