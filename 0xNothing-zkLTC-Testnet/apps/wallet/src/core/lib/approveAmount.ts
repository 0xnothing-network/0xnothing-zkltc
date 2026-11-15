import { type Address, getAddress, type Hex } from "viem";

/**
 * The spending-cap editor of the approval window. A dapp's ERC-20 approve or
 * increaseAllowance may be signed with a LOWER amount than it asked for; nothing
 * else about the call may change. These functions are the only place that builds
 * such calldata, and they work on the exact bytes: viem's decoder accepts
 * trailing bytes, so it cannot be the gate here.
 */
export const APPROVE_SELECTOR = "0x095ea7b3";
export const INCREASE_ALLOWANCE_SELECTOR = "0x39509351";

export interface ApproveCall {
  selector: typeof APPROVE_SELECTOR | typeof INCREASE_ALLOWANCE_SELECTOR;
  spender: Address;
  amount: bigint;
}

/** Selector (10 chars with 0x) + spender word (64) = everything that must stay verbatim. */
const PREFIX_LENGTH = 74;
const STRICT_CALL = /^0x[0-9a-fA-F]{136}$/u;

function parseWords(data: string): ApproveCall | null {
  const selector = data.slice(0, 10).toLowerCase();
  if (selector !== APPROVE_SELECTOR && selector !== INCREASE_ALLOWANCE_SELECTOR) return null;
  const spenderWord = data.slice(10, PREFIX_LENGTH);
  // The high 12 bytes must be clean: a contract reads only the low 20, so an
  // address shown from a dirty word would not be the one it approves.
  if (!/^0{24}[0-9a-fA-F]{40}$/u.test(spenderWord)) return null;
  const amountWord = data.slice(PREFIX_LENGTH, PREFIX_LENGTH + 64);
  if (!/^[0-9a-fA-F]{64}$/u.test(amountWord)) return null;
  return {
    selector,
    spender: getAddress(`0x${spenderWord.slice(24)}`),
    amount: BigInt(`0x${amountWord}`),
  };
}

/** Strict: exactly 4 + 32 + 32 bytes of one of the two calls. Total: never throws. */
export function parseApproveCall(data: unknown): ApproveCall | null {
  try {
    if (typeof data !== "string" || !STRICT_CALL.test(data)) return null;
    return parseWords(data);
  } catch {
    return null;
  }
}

/** Lenient form for records of past approvals: the two words must be there, anything may follow. */
export function parseApproveCallLenient(data: unknown): ApproveCall | null {
  try {
    if (typeof data !== "string" || data.length < 138 || data.length > 100_000) return null;
    if (!/^0x[0-9a-fA-F]*$/u.test(data) || data.length % 2 !== 0) return null;
    return parseWords(data);
  } catch {
    return null;
  }
}

/**
 * The same bytes with only the amount word replaced. Null unless the call parses
 * strictly and 0 <= amount <= the requested amount. The requested amount itself
 * returns the very same string, so the default signs the dapp's exact bytes.
 */
export function rewriteApproveAmount(data: unknown, amount: unknown): Hex | null {
  const parsed = parseApproveCall(data);
  if (parsed === null || typeof data !== "string") return null;
  if (typeof amount !== "bigint" || amount < 0n || amount > parsed.amount) return null;
  if (amount === parsed.amount) return data as Hex;
  return `${data.slice(0, PREFIX_LENGTH)}${amount.toString(16).padStart(64, "0")}` as Hex;
}

/** True only for the same call to the same spender with an amount no higher than the original. */
export function isLoweredApprove(original: unknown, candidate: unknown): boolean {
  const before = parseApproveCall(original);
  const after = parseApproveCall(candidate);
  if (before === null || after === null) return false;
  if (typeof original !== "string" || typeof candidate !== "string") return false;
  return original.slice(0, PREFIX_LENGTH) === candidate.slice(0, PREFIX_LENGTH) && after.amount <= before.amount;
}

/** ERC-721's ERC-165 interface id: approve(address,uint256) is also its call, with a token id. */
export const ERC721_INTERFACE_ID = "0x80ac58cd";

/**
 * Reads the outcome of supportsInterface(0x80ac58cd) on an approve target.
 * true: an NFT, whose "amount" is a token id and must never be edited.
 * false: it answered false, or it has no such function (a revert, or no data).
 * null: unknown (timeout, RPC down, anything else), which also keeps the editor off.
 */
export function nftFromProbe(outcome: { answer: unknown } | { error: unknown }): boolean | null {
  if ("answer" in outcome) return outcome.answer === true ? true : outcome.answer === false ? false : null;
  const seen = new Set<unknown>();
  let current: unknown = outcome.error;
  while (typeof current === "object" && current !== null && !seen.has(current)) {
    seen.add(current);
    const error = current as { name?: unknown; details?: unknown; shortMessage?: unknown; cause?: unknown };
    if (
      error.name === "ContractFunctionRevertedError"
      || error.name === "ContractFunctionZeroDataError"
      || error.name === "AbiDecodingZeroDataError"
    ) return false;
    // A plain revert without data comes back from geth as -32000 "execution reverted",
    // which viem leaves unclassified.
    const reverted = (text: unknown) => typeof text === "string" && /^execution reverted\b/u.test(text);
    if (reverted(error.details) || reverted(error.shortMessage)) return false;
    current = error.cause;
  }
  return null;
}
