import type { ReactNode } from "react";
import { Icon } from "./kit";

/** Compact trust mark for canonical assets; decorative beside the token name. */
export function VerifiedMark({ verified }: { verified?: boolean }): ReactNode {
  return verified ? (
    <span className="w-verified-mark" aria-hidden="true"><Icon name="check" size={9} /></span>
  ) : null;
}
