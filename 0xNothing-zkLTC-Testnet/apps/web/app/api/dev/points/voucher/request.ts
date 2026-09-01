import {
  getAddress,
  isAddress,
  maxUint256,
  type Address,
  type Hex,
} from "viem";
import type { PointsVoucherAuthorization } from "../../../../../features/fi/lib/pointsVoucher.ts";

const DECIMAL_UINT = /^(0|[1-9]\d{0,77})$/;
const REQUEST_NONCE = /^[a-zA-Z0-9_-]{16,96}$/;
const SIGNATURE = /^0x[0-9a-fA-F]{130}$/;

export interface VoucherRequest extends PointsVoucherAuthorization {
  message: string;
  signature: Hex;
}

export function isJsonContentType(value: string | null): boolean {
  return value?.split(";", 1)[0]?.trim().toLowerCase() === "application/json";
}

function validUint(value: unknown): value is string {
  if (typeof value !== "string" || !DECIMAL_UINT.test(value)) return false;
  return BigInt(value) <= maxUint256;
}

export function parseVoucherRequestBody(
  value: unknown,
  expectedChainId: number,
): VoucherRequest | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const body = value as Record<string, unknown>;
  if (
    typeof body.domain !== "string"
    || typeof body.admin !== "string"
    || typeof body.contract !== "string"
    || body.chainId !== expectedChainId
    || typeof body.account !== "string"
    || typeof body.recipient !== "string"
    || !validUint(body.pointCredits)
    || !validUint(body.nonce)
    || !validUint(body.deadline)
    || !validUint(body.rateVersion)
    || typeof body.issuedAt !== "string"
    || typeof body.requestNonce !== "string"
    || typeof body.message !== "string"
    || typeof body.signature !== "string"
    || !isAddress(body.admin)
    || !isAddress(body.contract)
    || !isAddress(body.account)
    || !isAddress(body.recipient)
    || !REQUEST_NONCE.test(body.requestNonce)
    || !SIGNATURE.test(body.signature)
  ) {
    return undefined;
  }

  return {
    domain: body.domain,
    admin: getAddress(body.admin) as Address,
    contract: getAddress(body.contract) as Address,
    chainId: expectedChainId,
    account: getAddress(body.account) as Address,
    recipient: getAddress(body.recipient) as Address,
    pointCredits: body.pointCredits,
    nonce: body.nonce,
    deadline: body.deadline,
    rateVersion: body.rateVersion,
    issuedAt: body.issuedAt,
    requestNonce: body.requestNonce,
    message: body.message,
    signature: body.signature as Hex,
  };
}
