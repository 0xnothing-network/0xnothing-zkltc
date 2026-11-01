"use client";

import Link from "next/link";
import "@/app/recovery.css";

export function RecoveryPanel({ digest }: { digest?: string }) {
  return (
    <main className="nothing-recovery-page">
      <Link href="/" className="nothing-recovery-brand" aria-label="0xNothing home">0xNothing</Link>
      <section className="nothing-recovery-content" aria-labelledby="recovery-title">
        <p className="nothing-recovery-code">Page unavailable</p>
        <h1 id="recovery-title">Let&apos;s try that again.</h1>
        <p>We couldn&apos;t load this page. Try again to reload it.</p>
        <p className="nothing-recovery-note">If you submitted a transaction, check its status in your wallet before trying again.</p>
        <div className="nothing-recovery-actions">
          {/* A reload, not reset(): reset re-renders the same server payload, and a chunk
              missing after a deploy only comes back with a fresh page. */}
          <button type="button" onClick={() => window.location.reload()}>Try again <span aria-hidden="true">↗</span></button>
          <Link href="/">Back to home <span aria-hidden="true">→</span></Link>
        </div>
        {digest ? <p className="nothing-recovery-reference">Reference: {digest}</p> : null}
      </section>
      <Link href="/docs" className="nothing-recovery-docs">Read the docs <span aria-hidden="true">→</span></Link>
    </main>
  );
}
