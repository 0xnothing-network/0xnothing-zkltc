/**
 * Map viem / wagmi / wallet errors into short, user-friendly messages.
 * Keep messages calm and actionable — never expose raw stack traces,
 * hex data, or long contract names to end users.
 */

export type ToastKind = "error" | "success" | "info" | "warning";

export interface NormalizedError {
  title: string;
  description?: string;
  kind: ToastKind;
}

interface MaybeError {
  shortMessage?: string;
  message?: string;
  details?: string;
  reason?: string;
  code?: number | string;
  name?: string;
  cause?: unknown;
}

/** Patterns that signal a deliberate rejection by the user in the wallet. */
const REJECT_PATTERNS = [
  "user rejected",
  "user denied",
  "user cancel",
  "rejected the request",
  "user dismissed",
  "user closed",
  "action_rejected",
  "request rejected",
];

/** Patterns that signal the user has no wallet installed at all. */
const NO_WALLET_PATTERNS = [
  "no provider",
  "no injected provider",
  "provider not found",
  "wallet not found",
  "no wallet",
  "no ethereum provider",
];

/** Patterns for connectivity / RPC failures. */
const RPC_PATTERNS = [
  "network error",
  "fetch failed",
  "failed to fetch",
  "rpc request failed",
  "timeout",
  "connection refused",
  "etimedout",
  "econnrefused",
  "503",
  "504",
  "502",
  "500",
];

/** Patterns for insufficient funds. */
const FUNDS_PATTERNS = [
  "insufficient funds",
  "insufficient balance",
  "not enough",
  "gas required exceeds",
];

const CONTRACT_PATTERNS: { pattern: RegExp; title: string; description: string }[] = [
  {
    pattern: /already\s*minted|already\s*exists|duplicate|token id already/i,
    title: "Already minted",
    description: "Someone has already minted this exact artwork.",
  },
  {
    pattern: /not the owner|not.*owner|unauthorized|caller is not/i,
    title: "Not allowed",
    description: "Your wallet isn't authorized for this action.",
  },
  {
    pattern: /not approved|approval|not approved for/i,
    title: "Approval needed",
    description: "Approve the marketplace to handle your NFT first.",
  },
  {
    pattern: /incorrect price|wrong price|listing price/i,
    title: "Wrong price",
    description: "The listing price doesn't match the contract.",
  },
  {
    pattern: /paused|contract paused|trading paused/i,
    title: "Contract paused",
    description: "Minting is temporarily disabled. Try again later.",
  },
  {
    pattern: /exceeds block gas limit|out of gas|gas required exceeds/i,
    title: "Out of gas",
    description: "This artwork is too complex — try a smaller grid or fewer colors.",
  },
  {
    pattern: /nonce too low|nonce.*already|replacement.*underpriced/i,
    title: "Stale transaction",
    description: "Wait a moment and try again.",
  },
  {
    pattern: /chain mismatch|wrong chain|unsupported chain|switch chain/i,
    title: "Wrong network",
    description: "Switch your wallet to the LitVM LiteForge network.",
  },
];

function pickLower(...sources: (string | undefined | null)[]): string {
  return sources.filter(Boolean).join(" ").toLowerCase();
}

export function normalizeError(err: unknown): NormalizedError {
  if (err == null) {
    return { title: "Something went wrong", kind: "error" };
  }

  // Extract the most useful string from the error and its cause chain.
  const e = err as MaybeError;
  const haystack = pickLower(
    e.shortMessage,
    e.message,
    e.details,
    e.reason,
    typeof err === "string" ? err : null
  );

  // User rejection — calm, not scary. Don't call it an "error".
  if (REJECT_PATTERNS.some((p) => haystack.includes(p))) {
    return {
      title: "Request canceled",
      description: "No transaction was sent.",
      kind: "info",
    };
  }

  // No wallet — actionable guidance.
  if (NO_WALLET_PATTERNS.some((p) => haystack.includes(p))) {
    return {
      title: "No wallet detected",
      description: "Install MetaMask or another Web3 wallet to continue.",
      kind: "warning",
    };
  }

  // Connectivity.
  if (RPC_PATTERNS.some((p) => haystack.includes(p))) {
    return {
      title: "Network unreachable",
      description: "Couldn't reach the LitVM RPC — check your connection and retry.",
      kind: "warning",
    };
  }

  // Funds.
  if (FUNDS_PATTERNS.some((p) => haystack.includes(p))) {
    return {
      title: "Insufficient balance",
      description: "You need a little zkLTC for gas fees.",
      kind: "warning",
    };
  }

  // Smart-contract revert reasons.
  for (const { pattern, title, description } of CONTRACT_PATTERNS) {
    if (pattern.test(haystack)) {
      return { title, description, kind: "error" };
    }
  }

  // Fallback: pick the most concise raw string we have.
  const raw = e.shortMessage || e.reason || e.message || e.details || String(err);
  const trimmed = raw.replace(/^Error:\s*/i, "").split("\n")[0].slice(0, 140);
  return {
    title: trimmed || "Something went wrong",
    description: "Please try again, or check the console for details.",
    kind: "error",
  };
}

/** Pretty-print a wallet/contract address for display in toasts. */
export function shortHashOrAddr(value?: string | null, head = 6, tail = 4): string {
  if (!value) return "";
  if (value.length <= head + tail + 2) return value;
  return `${value.slice(0, head)}…${value.slice(-tail)}`;
}
