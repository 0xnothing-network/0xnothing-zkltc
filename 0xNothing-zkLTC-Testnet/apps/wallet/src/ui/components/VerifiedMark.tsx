import type { ReactNode } from "react";

/** Compact trust mark for canonical assets; decorative beside the token name. */
export function VerifiedMark({ verified }: { verified?: boolean }): ReactNode {
  return verified ? (
    <span className="w-verified-mark" aria-hidden="true">✓</span>
  ) : null;
}
