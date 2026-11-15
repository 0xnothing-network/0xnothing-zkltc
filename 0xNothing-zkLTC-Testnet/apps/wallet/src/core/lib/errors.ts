import {
  BaseError,
  ContractFunctionRevertedError,
  type Hex,
  HttpRequestError,
  UserRejectedRequestError,
} from "viem";
import { type MessageKey, t } from "../i18n";

/**
 * A transaction was signed and its broadcast failed, but the wallet cannot tell
 * whether the node took it: the answer was lost and the hash was not found
 * either. It is neither sent nor failed. Its pending history row is already
 * written, so the user checks History instead of signing a second copy.
 */
export class BroadcastUnknownError extends Error {
  override readonly name = "BroadcastUnknownError";
  constructor(readonly hash: Hex, cause: unknown) {
    super(t("err.broadcastUnknown"), { cause });
  }
}

/**
 * The first leg of a two-stage swap went through and the second did not. The
 * input is already spent: the user now holds the NUSD in between, and must be
 * told so rather than see a plain refusal and swap the input a second time.
 */
export class StagedSwapError extends Error {
  override readonly name = "StagedSwapError";
  constructor(
    /** The stage-1 transaction. */
    readonly hash: Hex,
    /** NUSD the first leg delivered, in base units. */
    readonly delivered: bigint,
    /** The same amount, formatted for the message. */
    readonly bridged: string,
    cause: unknown,
  ) {
    super(t("swap.stagedFailed", { bridged, reason: describeError(cause) }), { cause });
  }
}

/**
 * Turns viem's very long error chains into one line a user can act on.
 * The original error is never swallowed — callers keep it for the console.
 */
export function describeError(error: unknown): string {
  // Before the viem and hint paths: the message wrapped inside must not be read
  // back as "timed out" or "refused", which would hide what the wallet knows.
  if (error instanceof BroadcastUnknownError) return t("err.broadcastUnknown");
  if (error instanceof StagedSwapError) {
    return t("swap.stagedFailed", { bridged: error.bridged, reason: describeError(error.cause) });
  }
  if (error instanceof UserRejectedRequestError) return t("err.rejected");

  if (error instanceof BaseError) {
    const reverted = error.walk((cause) => cause instanceof ContractFunctionRevertedError);
    if (reverted instanceof ContractFunctionRevertedError) {
      const name = reverted.data?.errorName;
      const reason = reverted.reason;
      if (name) return t("err.reverted", { reason: name });
      if (reason) return t("err.reverted", { reason });
      return t("err.revertedPlain");
    }
    // The endpoint said no (quota, IP block). viem's short message for it is
    // only "HTTP request failed.", so the status is the one thing to read.
    const http = error.walk((cause) => cause instanceof HttpRequestError);
    if (http instanceof HttpRequestError && http.status === 403) return t("err.rpcRefused");
    const short = error.shortMessage?.trim();
    if (short) return normalise(short);
  }

  const text = error instanceof Error ? error.message : String(error);
  return normalise(text.split("\n")[0] ?? t("err.unknown"));
}

/**
 * The node's wording is English, unbounded and often unhelpful; these eight
 * patterns cover what a user of this wallet actually hits, and they are matched
 * against the raw message so the mapping is independent of the UI language.
 */
const HINTS: readonly (readonly [RegExp, MessageKey])[] = [
  [/insufficient funds/iu, "err.noGas"],
  [/nonce too low|nonce has already been used/iu, "err.nonce"],
  [/replacement transaction underpriced/iu, "err.underpriced"],
  [/intrinsic gas too low/iu, "err.gasLow"],
  [/rate limit|too many requests|bandwidth limit/iu, "err.rateLimit"],
  [/timed? out|timeout/iu, "err.timeout"],
  // Signer refusals only: a dapp's revert reason such as "Access denied" is
  // the contract talking, not the user, and is shown as a revert below.
  [/user rejected|user denied|rejected by (?:the )?user/iu, "err.rejected"],
  [/transfer amount exceeds balance/iu, "err.balance"],
];

function normalise(message: string): string {
  // viem's EstimateGasExecutionError and its kin carry the revert reason only
  // in this sentence; the reason is the dapp's own text, so it is quoted
  // rather than matched against the hints.
  const reverted = /^Execution reverted with reason: (.+?)\.?$/u.exec(message);
  if (reverted?.[1]) return t("err.reverted", { reason: reverted[1] });
  for (const [pattern, key] of HINTS) {
    if (pattern.test(message)) return t(key);
  }
  return message.length > 160 ? `${message.slice(0, 157)}…` : message;
}
