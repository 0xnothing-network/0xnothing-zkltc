import Link from "next/link";
import { fiPath } from "@fi/config/paths";

export function GraduationExplainer() {
  return (
    <details className="fi-settings-details fi-graduation-explainer">
      <summary><span>Graduated tokens</span><strong>How it works</strong></summary>
      <div className="fi-inline-state">
        <div>
          <p>
            Completed <Link href="/0xPump" className="fi-text-link">0xPump</Link> curves become protected DEX pools.
            They appear in <Link href={fiPath("/swap")} className="fi-text-link">Swap</Link> with a Graduated badge.
          </p>
        </div>
      </div>
    </details>
  );
}
