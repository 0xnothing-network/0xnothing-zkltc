import Link from "next/link";
import { fiPath } from "@fi/config/paths";

export function GraduationExplainer() {
  return (
    <div className="fi-inline-state fi-graduation-explainer">
      <div>
        <strong>How token graduation works</strong>
        <p>
          Tokens launch on <Link href="/0xPump" className="fi-text-link">0xPump</Link> with a bonding curve.
          When the curve completes, the market becomes Ready and anyone can trigger graduation.
          The protocol creates a protected pair, transfers the curve&apos;s token and NUSD reserves, and mints the first LP position at the final curve price.
          After that, the token is freely traded on the DEX. Graduated tokens appear in <Link href={fiPath("/swap")} className="fi-text-link">Swap</Link> with a Graduated badge.
        </p>
      </div>
    </div>
  );
}
