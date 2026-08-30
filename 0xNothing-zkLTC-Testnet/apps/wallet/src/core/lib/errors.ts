import { BaseError, ContractFunctionRevertedError, UserRejectedRequestError } from "viem";
import { type MessageKey, t } from "../i18n";

/**
 * Turns viem's very long error chains into one line a user can act on.
 * The original error is never swallowed — callers keep it for the console.
 */
export function describeError(error: unknown): string {
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
  [/user rejected|denied/iu, "err.rejected"],
  [/transfer amount exceeds balance/iu, "err.balance"],
];

function normalise(message: string): string {
  for (const [pattern, key] of HINTS) {
    if (pattern.test(message)) return t(key);
  }
  return message.length > 160 ? `${message.slice(0, 157)}…` : message;
}

/** Errors that mean "the wallet is locked", so the UI can route to Unlock. */
export function isLockedError(error: unknown): boolean {
  return error instanceof Error && error.name === "WalletLockedError";
}
