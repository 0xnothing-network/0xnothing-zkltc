import { type Address, decodeFunctionData, getAddress, type Hex, isAddress, isHex, maxUint256, parseAbi } from "viem";

/**
 * What a dapp request lets someone do with the signer's assets, read out of the
 * calldata or the EIP-712 message so the approval window can name the spender,
 * the amount and the deadline instead of leaving them inside hex or JSON.
 *
 * Only shapes that move or unlock assets are read: ERC-20 transfer, approve and
 * increaseAllowance (the usual way around approve warnings), ERC-721 transfers,
 * setApprovalForAll, EIP-2612 and DAI permits, and Permit2 allowance and transfer
 * signatures. Anything else returns null and the window shows it raw, as before.
 */
export interface Grant {
  token: Address;
  /** Raw token units. */
  amount: bigint;
}

export type RequestEffect =
  | { kind: "transfer"; token: Address; from: Address | null; to: Address; amount: bigint }
  | { kind: "nft-transfer"; from: Address; to: Address; tokenId: bigint }
  /** `validUntil` is null when a signed grant never lapses; a call's grant has no deadline. */
  | { kind: "approve"; spender: Address; grants: Grant[]; signed: boolean; validUntil: bigint | null }
  | { kind: "approve-all"; operator: Address; approved: boolean };

/** No real supply reaches 2^128 units; uint256 max and Permit2's 2^160 - 1 both clear it. */
export const UNLIMITED = 2n ** 128n;

/** 9999-12-31T23:59:59Z. A later deadline reads as no expiry rather than as a date. */
const LAST_DATE = 253_402_300_799n;

const CALLS = parseAbi([
  "function transfer(address to, uint256 amount)",
  "function approve(address spender, uint256 amount)",
  "function increaseAllowance(address spender, uint256 addedValue)",
  "function transferFrom(address from, address to, uint256 amount)",
  "function safeTransferFrom(address from, address to, uint256 tokenId)",
  "function safeTransferFrom(address from, address to, uint256 tokenId, bytes data)",
  "function setApprovalForAll(address operator, bool approved)",
]);

/**
 * ERC-20 and ERC-721 share the approve and transferFrom selectors, so the third
 * argument is an amount or a token ID depending on the contract. The caller
 * finds out by reading `decimals()`; an NFT has none and shows raw units.
 */
export function callEffect(to: string | undefined, data: string | undefined): RequestEffect | null {
  if (to === undefined || !isAddress(to, { strict: false }) || data === undefined || !isHex(data)) return null;
  const token = getAddress(to);
  const call = decodeCall(data);
  if (call === null) return null;
  switch (call.functionName) {
    case "transfer": {
      const [recipient, amount] = call.args;
      return { kind: "transfer", token, from: null, to: recipient, amount };
    }
    case "transferFrom": {
      const [from, recipient, amount] = call.args;
      return { kind: "transfer", token, from, to: recipient, amount };
    }
    case "approve":
    case "increaseAllowance": {
      const [spender, amount] = call.args;
      return { kind: "approve", spender, grants: [{ token, amount }], signed: false, validUntil: null };
    }
    case "safeTransferFrom": {
      const [from, recipient, tokenId] = call.args;
      return { kind: "nft-transfer", from, to: recipient, tokenId };
    }
    case "setApprovalForAll": {
      const [operator, approved] = call.args;
      return { kind: "approve-all", operator, approved };
    }
  }
}

function decodeCall(data: Hex) {
  try {
    return decodeFunctionData({ abi: CALLS, data });
  } catch {
    return null;
  }
}

/**
 * A permit's meaning is fixed by its type hash, which commits to the primary
 * type and field names. A real one therefore always arrives under one of these
 * names; a message that only resembles one cannot pass as it on chain.
 */
export function typedEffect(message: string): RequestEffect | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(message);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || !isRecord(parsed.message)) return null;
  const domain = isRecord(parsed.domain) ? parsed.domain : {};
  const body = parsed.message;
  const spender = address(body.spender);
  if (spender === null) return null;
  switch (parsed.primaryType) {
    case "Permit":
      return permit(address(domain.verifyingContract), body, spender);
    case "PermitSingle":
      return allowancePermit([body.details], spender);
    case "PermitBatch":
      return allowancePermit(body.details, spender);
    case "PermitTransferFrom":
    case "PermitWitnessTransferFrom":
      return transferPermit([body.permitted], spender, body.deadline);
    case "PermitBatchTransferFrom":
    case "PermitBatchWitnessTransferFrom":
      return transferPermit(body.permitted, spender, body.deadline);
    default:
      return null;
  }
}

/** EIP-2612 (owner, spender, value, nonce, deadline) or DAI (holder, spender, nonce, expiry, allowed). */
function permit(token: Address | null, body: Record<string, unknown>, spender: Address): RequestEffect | null {
  if (token === null) return null;
  if (body.value !== undefined) {
    const amount = uint(body.value);
    const deadline = uint(body.deadline);
    return amount === null || deadline === null ? null : signedGrant(spender, [{ token, amount }], deadline);
  }
  // DAI's expiry 0 never lapses, and `allowed` grants the whole balance.
  const expiry = uint(body.expiry);
  if (typeof body.allowed !== "boolean" || expiry === null) return null;
  return signedGrant(spender, [{ token, amount: body.allowed ? maxUint256 : 0n }], expiry === 0n ? null : expiry);
}

/** Permit2 PermitDetails (token, amount, expiration, nonce): a batch lasts until its latest expiration. */
function allowancePermit(details: unknown, spender: Address): RequestEffect | null {
  if (!Array.isArray(details) || details.length === 0) return null;
  const grants: Grant[] = [];
  let until = 0n;
  for (const entry of details) {
    if (!isRecord(entry)) return null;
    const token = address(entry.token);
    const amount = uint(entry.amount);
    const expiration = uint(entry.expiration);
    if (token === null || amount === null || expiration === null) return null;
    grants.push({ token, amount });
    if (expiration > until) until = expiration;
  }
  return signedGrant(spender, grants, until);
}

/** Permit2 TokenPermissions (token, amount): a one-off pull, open until the deadline. */
function transferPermit(permitted: unknown, spender: Address, rawDeadline: unknown): RequestEffect | null {
  const deadline = uint(rawDeadline);
  if (!Array.isArray(permitted) || permitted.length === 0 || deadline === null) return null;
  const grants: Grant[] = [];
  for (const entry of permitted) {
    if (!isRecord(entry)) return null;
    const token = address(entry.token);
    const amount = uint(entry.amount);
    if (token === null || amount === null) return null;
    grants.push({ token, amount });
  }
  return signedGrant(spender, grants, deadline);
}

function signedGrant(spender: Address, grants: Grant[], validUntil: bigint | null): RequestEffect {
  return { kind: "approve", spender, grants, signed: true, validUntil };
}

/** The tokens whose symbol and decimals the window has to read, each once. */
export function effectTokens(effect: RequestEffect | null): Address[] {
  if (effect?.kind === "transfer") return [effect.token];
  if (effect?.kind === "approve") return [...new Set(effect.grants.map((grant) => grant.token))];
  return [];
}

/** Local date and minute of a unix deadline, or null when it never lapses. */
export function deadlineDate(seconds: bigint | null): string | null {
  if (seconds === null || seconds > LAST_DATE) return null;
  const date = new Date(Number(seconds) * 1000);
  const pad = (part: number): string => part.toString().padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function address(value: unknown): Address | null {
  return typeof value === "string" && isAddress(value, { strict: false }) ? getAddress(value) : null;
}

/** EIP-712 JSON carries uints as safe numbers, decimal strings or hex strings. */
function uint(value: unknown): bigint | null {
  let parsed: bigint;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) return null;
    parsed = BigInt(value);
  } else if (typeof value === "string" && /^(?:\d{1,78}|0x[0-9a-f]{1,64})$/iu.test(value)) {
    parsed = BigInt(value);
  } else {
    return null;
  }
  return parsed <= maxUint256 ? parsed : null;
}
