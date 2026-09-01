import { NextResponse } from "next/server";
import {
  getAddress,
  isAddress,
  verifyMessage,
  zeroAddress,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { litvm } from "@/config/wagmi";
import { publicClient } from "@/lib/contract";
import {
  trustedClientRateLimitKey,
  trustedProxyClientKey,
} from "@/lib/server/clientIp";
import { readLimitedBytes } from "@/lib/server/readLimitedBytes";
import { createSlidingWindowRateLimiter } from "@/lib/server/slidingWindowRateLimit";
import { nusdPointsStakingAbi } from "@fi/lib/abis/points";
import {
  buildPointsVoucherAuthorizationMessage,
  POINTS_EIP712_NAME,
  POINTS_EIP712_VERSION,
  pointsVoucherTypes,
} from "@fi/lib/pointsVoucher";
import {
  isJsonContentType,
  parseVoucherRequestBody,
} from "./request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 8 * 1024;
const AUTHORIZATION_TTL_MS = 5 * 60_000;
const FUTURE_CLOCK_SKEW_MS = 30_000;
const MAX_VOUCHER_TTL_SECONDS = 15 * 60;
const RATE_WINDOW_MS = 10 * 60_000;
const RATE_MAX_ATTEMPTS = 10;
const MAX_RATE_LIMIT_KEYS = 4_096;
const PRIVATE_KEY = /^0x[0-9a-fA-F]{64}$/;

const requestRateLimiter = createSlidingWindowRateLimiter({
  windowMs: RATE_WINDOW_MS,
  maxAttempts: RATE_MAX_ATTEMPTS,
  maxKeys: MAX_RATE_LIMIT_KEYS,
});

class RequestBodyTooLargeError extends Error {}

function jsonError(error: string, status: number) {
  return NextResponse.json(
    { error },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}

function configuredAddress(value: string | undefined): Address | undefined {
  const candidate = value?.trim();
  if (!candidate || !isAddress(candidate) || candidate.toLowerCase() === zeroAddress) return undefined;
  return getAddress(candidate);
}

function normalizedDomain(value: string | undefined): string | undefined {
  const candidate = value?.trim().toLowerCase();
  if (!candidate || candidate.length > 253 || /[\s/@\\]/.test(candidate)) return undefined;
  try {
    const parsed = new URL(`http://${candidate}`);
    if (parsed.host !== candidate || parsed.pathname !== "/") return undefined;
    return parsed.host;
  } catch {
    return undefined;
  }
}

async function boundedJson(request: Request): Promise<unknown> {
  if (!request.body) throw new SyntaxError("Missing request body");
  const declaredLength = request.headers.get("content-length")?.trim();
  if (declaredLength && /^\d+$/.test(declaredLength) && BigInt(declaredLength) > BigInt(MAX_BODY_BYTES)) {
    await request.body.cancel().catch(() => undefined);
    throw new RequestBodyTooLargeError();
  }
  const bytes = await readLimitedBytes(
    request.body,
    MAX_BODY_BYTES,
    () => new RequestBodyTooLargeError(),
  );
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  return JSON.parse(text) as unknown;
}

function trustedClientKey(request: Request): string {
  return trustedProxyClientKey(
    request,
    process.env.POINTS_TRUSTED_PROXY_CLIENT_IP_HEADER,
    process.env.VERCEL === "1",
    process.env.TRUSTED_PROXY_SHARED_SECRET,
    process.env.CLOUDFLARE_WORKERS === "true",
  );
}

function requestIsSameOrigin(request: Request, expectedDomain: string): boolean {
  const fetchSite = request.headers.get("sec-fetch-site")?.toLowerCase();
  if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none") return false;
  const origin = request.headers.get("origin");
  if (!origin) return process.env.NODE_ENV !== "production";
  try {
    const parsed = new URL(origin);
    return (parsed.protocol === "https:" || parsed.protocol === "http:")
      && parsed.host.toLowerCase() === expectedDomain;
  } catch {
    return false;
  }
}

export async function POST(request: Request) {
  if (!isJsonContentType(request.headers.get("content-type"))) {
    return jsonError("Voucher requests must use JSON", 415);
  }

  const contract = configuredAddress(process.env.POINTS_STAKING_ADDRESS);
  const expectedDomain = normalizedDomain(process.env.POINTS_SIGNING_DOMAIN);
  const privateKey = process.env.POINTS_SIGNER_PRIVATE_KEY?.trim();
  if (!contract || !expectedDomain || !privateKey || !PRIVATE_KEY.test(privateKey)) {
    return jsonError("xPoints voucher signing is not configured", 503);
  }
  let signer: ReturnType<typeof privateKeyToAccount>;
  try {
    signer = privateKeyToAccount(privateKey as Hex);
  } catch {
    return jsonError("xPoints voucher signing is not configured", 503);
  }
  if (!requestIsSameOrigin(request, expectedDomain)) {
    return jsonError("Voucher request origin is not allowed", 403);
  }

  let rawBody: unknown;
  try {
    rawBody = await boundedJson(request);
  } catch (error) {
    return jsonError(
      error instanceof RequestBodyTooLargeError ? "Voucher request is too large" : "Invalid JSON request",
      error instanceof RequestBodyTooLargeError ? 413 : 400,
    );
  }
  const body = parseVoucherRequestBody(rawBody, litvm.id);
  if (!body) return jsonError("Invalid voucher request", 400);
  if (
    body.domain.toLowerCase() !== expectedDomain
    || body.contract.toLowerCase() !== contract.toLowerCase()
  ) {
    return jsonError("Signed voucher scope does not match this deployment", 401);
  }
  if (body.account === zeroAddress || body.recipient === zeroAddress || body.recipient === contract) {
    return jsonError("Invalid voucher account or recipient", 400);
  }

  const nowMs = Date.now();
  const nowSeconds = BigInt(Math.floor(nowMs / 1000));
  const issuedAt = Date.parse(body.issuedAt);
  const pointCredits = BigInt(body.pointCredits);
  const nonce = BigInt(body.nonce);
  const deadline = BigInt(body.deadline);
  const requestedRateVersion = BigInt(body.rateVersion);
  if (
    !Number.isFinite(issuedAt)
    || issuedAt < nowMs - AUTHORIZATION_TTL_MS
    || issuedAt > nowMs + FUTURE_CLOCK_SKEW_MS
  ) {
    return jsonError("Voucher authorization has expired", 401);
  }
  if (
    pointCredits === 0n
    || deadline <= nowSeconds
    || deadline > nowSeconds + BigInt(MAX_VOUCHER_TTL_SECONDS)
  ) {
    return jsonError("Invalid voucher amount or deadline", 400);
  }

  const expectedMessage = buildPointsVoucherAuthorizationMessage(body);
  if (body.message !== expectedMessage) {
    return jsonError("Signed voucher message is not canonical", 401);
  }
  let adminSignatureValid = false;
  try {
    adminSignatureValid = await verifyMessage({
      address: body.admin,
      message: expectedMessage,
      signature: body.signature,
    });
  } catch {
    adminSignatureValid = false;
  }
  if (!adminSignatureValid) return jsonError("Wallet authorization failed", 401);

  let owner: Address;
  try {
    owner = await publicClient.readContract({
      address: contract,
      abi: nusdPointsStakingAbi,
      functionName: "owner",
    });
  } catch {
    return jsonError("Could not verify current xPoints contract state", 503);
  }
  if (body.admin.toLowerCase() !== owner.toLowerCase()) {
    return jsonError("Only the on-chain owner may authorize vouchers", 403);
  }

  // Consume the authenticated owner/IP budget before the remaining contract
  // reads. Otherwise even rejected or already rate-limited requests can fan out
  // into a large RPC batch and turn this operator-only endpoint into a relay.
  const rateKeys = [`admin:${owner.toLowerCase()}`];
  const ipRateKey = trustedClientRateLimitKey(trustedClientKey(request));
  if (ipRateKey) rateKeys.push(ipRateKey);
  if (!requestRateLimiter.consume(rateKeys, nowMs)) {
    return NextResponse.json(
      { error: "Voucher rate limit reached. Wait before trying again." },
      { status: 429, headers: { "Cache-Control": "no-store", "Retry-After": "600" } },
    );
  }

  let state: readonly [Address, bigint, bigint, boolean, boolean, bigint, bigint, bigint, boolean];
  try {
    state = await Promise.all([
      publicClient.readContract({ address: contract, abi: nusdPointsStakingAbi, functionName: "redemptionSigner" }),
      publicClient.readContract({ address: contract, abi: nusdPointsStakingAbi, functionName: "redemptionNonces", args: [body.account] }),
      publicClient.readContract({ address: contract, abi: nusdPointsStakingAbi, functionName: "rateVersion" }),
      publicClient.readContract({ address: contract, abi: nusdPointsStakingAbi, functionName: "redemptionEnabled" }),
      publicClient.readContract({ address: contract, abi: nusdPointsStakingAbi, functionName: "redemptionsPaused" }),
      publicClient.readContract({ address: contract, abi: nusdPointsStakingAbi, functionName: "availablePointCredits", args: [body.account] }),
      publicClient.readContract({ address: contract, abi: nusdPointsStakingAbi, functionName: "redemptionReserve" }),
      publicClient.readContract({ address: contract, abi: nusdPointsStakingAbi, functionName: "quoteRedemption", args: [pointCredits] }),
      publicClient.readContract({ address: contract, abi: nusdPointsStakingAbi, functionName: "isSolvent" }),
    ]);
  } catch {
    return jsonError("Could not verify current xPoints contract state", 503);
  }
  const [onchainSigner, currentNonce, rateVersion, enabled, paused, available, reserve, nusdOut, solvent] = state;
  if (signer.address.toLowerCase() !== onchainSigner.toLowerCase()) {
    return jsonError("Configured signer does not match the on-chain signer", 503);
  }
  if (!enabled || paused || !solvent) return jsonError("Redemptions are not currently available", 409);
  if (nonce !== currentNonce || requestedRateVersion !== rateVersion) {
    return jsonError("Voucher state changed; refresh and sign again", 409);
  }
  if (pointCredits > available || nusdOut === 0n || nusdOut > reserve) {
    return jsonError("Insufficient xPoints or redemption reserve", 409);
  }

  const voucher = {
    account: body.account,
    recipient: body.recipient,
    pointCredits,
    nonce,
    deadline,
    rateVersion,
  } as const;
  const voucherSignature = await signer.signTypedData({
    domain: {
      name: POINTS_EIP712_NAME,
      version: POINTS_EIP712_VERSION,
      chainId: litvm.id,
      verifyingContract: contract,
    },
    types: pointsVoucherTypes,
    primaryType: "RedeemVoucher",
    message: voucher,
  });

  return NextResponse.json(
    {
      voucher: {
        account: voucher.account,
        recipient: voucher.recipient,
        pointCredits: voucher.pointCredits.toString(),
        nonce: voucher.nonce.toString(),
        deadline: voucher.deadline.toString(),
        rateVersion: voucher.rateVersion.toString(),
      },
      signature: voucherSignature,
      signer: signer.address,
      nusdOut: nusdOut.toString(),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
