import assert from "node:assert/strict";
import test from "node:test";
import { verifyTypedData, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  buildPointsVoucherAuthorizationMessage,
  POINTS_EIP712_NAME,
  POINTS_EIP712_VERSION,
  pointsVoucherTypes,
  type PointsVoucherAuthorization,
} from "../../features/fi/lib/pointsVoucher.ts";

const contract = "0x1111111111111111111111111111111111111111" as Address;
const account = "0x2222222222222222222222222222222222222222" as Address;
const recipient = "0x3333333333333333333333333333333333333333" as Address;
// Deterministic test fixture only. It is never loaded by application code.
const fixtureSigner = privateKeyToAccount(
  "0x0000000000000000000000000000000000000000000000000000000000000001" as Hex,
);

const authorization: PointsVoucherAuthorization = {
  domain: "127.0.0.1:3300",
  admin: fixtureSigner.address,
  contract,
  chainId: 4441,
  account,
  recipient,
  pointCredits: "250000000000000000000",
  nonce: "7",
  deadline: "2000000300",
  rateVersion: "3",
  issuedAt: "2033-05-18T03:33:20.000Z",
  requestNonce: "1234567890abcdef1234567890abcdef",
};

test("points owner authorization is canonical and binds every voucher field", () => {
  const message = buildPointsVoucherAuthorizationMessage(authorization);
  assert.equal(
    message,
    [
      "0xNothing NUSD Points redemption authorization",
      "",
      "Domain: 127.0.0.1:3300",
      `Admin: ${fixtureSigner.address}`,
      `Contract: ${contract}`,
      "Chain ID: 4441",
      `Account: ${account}`,
      `Recipient: ${recipient}`,
      "0xPoints amount (20-decimal base units): 250000000000000000000",
      "Redemption nonce: 7",
      "Rate version: 3",
      "Voucher deadline: 2000000300",
      "Issued at: 2033-05-18T03:33:20.000Z",
      "Request nonce: 1234567890abcdef1234567890abcdef",
      "",
      "Signing authorizes only this voucher. It does not transfer funds by itself.",
    ].join("\n"),
  );
  assert.notEqual(
    message,
    buildPointsVoucherAuthorizationMessage({ ...authorization, recipient: account }),
  );
  assert.notEqual(
    message,
    buildPointsVoucherAuthorizationMessage({ ...authorization, rateVersion: "4" }),
  );
});

test("EIP-712 voucher signature is recipient-bound", async () => {
  const voucher = {
    account,
    recipient,
    pointCredits: 250_000_000_000_000_000_000n,
    nonce: 7n,
    deadline: 2_000_000_300n,
    rateVersion: 3n,
  } as const;
  const domain = {
    name: POINTS_EIP712_NAME,
    version: POINTS_EIP712_VERSION,
    chainId: 4441,
    verifyingContract: contract,
  } as const;
  const signature = await fixtureSigner.signTypedData({
    domain,
    types: pointsVoucherTypes,
    primaryType: "RedeemVoucher",
    message: voucher,
  });

  assert.equal(await verifyTypedData({
    address: fixtureSigner.address,
    domain,
    types: pointsVoucherTypes,
    primaryType: "RedeemVoucher",
    message: voucher,
    signature,
  }), true);
  assert.equal(await verifyTypedData({
    address: fixtureSigner.address,
    domain,
    types: pointsVoucherTypes,
    primaryType: "RedeemVoucher",
    message: { ...voucher, recipient: account },
    signature,
  }), false);
});
