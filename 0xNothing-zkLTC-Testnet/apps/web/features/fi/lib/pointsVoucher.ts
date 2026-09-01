import type { Address } from "viem";

export const POINTS_EIP712_NAME = "0xNothing NUSD Points" as const;
export const POINTS_EIP712_VERSION = "1" as const;

export const pointsVoucherTypes = {
  RedeemVoucher: [
    { name: "account", type: "address" },
    { name: "recipient", type: "address" },
    { name: "pointCredits", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
    { name: "rateVersion", type: "uint256" },
  ],
} as const;

export interface PointsVoucherAuthorization {
  domain: string;
  admin: Address;
  contract: Address;
  chainId: number;
  account: Address;
  recipient: Address;
  pointCredits: string;
  nonce: string;
  deadline: string;
  rateVersion: string;
  issuedAt: string;
  requestNonce: string;
}

/**
 * Canonical personal-sign message used only to authorize the server to issue
 * one tightly bound EIP-712 voucher. Every security-relevant field is included
 * so changing a recipient, rate, contract, chain or expiry requires a new
 * owner signature.
 */
export function buildPointsVoucherAuthorizationMessage(
  input: PointsVoucherAuthorization,
): string {
  return [
    "0xNothing NUSD Points redemption authorization",
    "",
    `Domain: ${input.domain}`,
    `Admin: ${input.admin}`,
    `Contract: ${input.contract}`,
    `Chain ID: ${input.chainId}`,
    `Account: ${input.account}`,
    `Recipient: ${input.recipient}`,
    `0xPoints amount (20-decimal base units): ${input.pointCredits}`,
    `Redemption nonce: ${input.nonce}`,
    `Rate version: ${input.rateVersion}`,
    `Voucher deadline: ${input.deadline}`,
    `Issued at: ${input.issuedAt}`,
    `Request nonce: ${input.requestNonce}`,
    "",
    "Signing authorizes only this voucher. It does not transfer funds by itself.",
  ].join("\n");
}
