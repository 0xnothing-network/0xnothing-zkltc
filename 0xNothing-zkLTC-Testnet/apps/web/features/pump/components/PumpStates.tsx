import Link from "next/link";
import { PixelLoadingIndicator } from "@/components/PageLoader";

export function PumpConfigNotice({ compact = false }: { compact?: boolean }) {
  return (
    <section className={compact ? "pump-notice compact" : "pump-notice"} role="status">
      <div>
        <span className="pump-eyebrow">Testnet setup</span>
        <h2>0xPump contracts are not configured</h2>
        <p>Browsing stays available, but create, trade, and vault actions remain disabled until deployment addresses are set.</p>
      </div>
      {!compact ? <Link href="/0xPump/create" className="pump-text-link">Review create flow</Link> : null}
    </section>
  );
}

export function PumpLoadingGrid({ count = 8 }: { count?: number }) {
  return (
    <div className="pump-loading-state" role="status" aria-label="Loading token markets">
      <div className="pump-loading-marker"><PixelLoadingIndicator compact /></div>
      <div className="pump-token-grid" aria-hidden="true">
        {Array.from({ length: count }).map((_, index) => (
          <div className="pump-token-card pump-skeleton" key={index}>
            <div className="pump-skeleton-logo" />
            <div className="pump-skeleton-line wide" />
            <div className="pump-skeleton-line" />
            <div className="pump-skeleton-line short" />
          </div>
        ))}
      </div>
    </div>
  );
}

export function PumpLoadingRows({ count = 3 }: { count?: number }) {
  return (
    <div className="pump-loading-rows" role="status" aria-label="Loading portfolio">
      <div className="pump-loading-marker"><PixelLoadingIndicator compact /></div>
      {Array.from({ length: count }).map((_, index) => (
        <span className="pump-loading-row" key={index} aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
      ))}
    </div>
  );
}

export function PumpInlineLoading({ label = "Loading" }: { label?: string }) {
  return (
    <div className="pump-inline-loading" role="status" aria-label={label}>
      <PixelLoadingIndicator compact />
    </div>
  );
}

export function PumpPageLoader() {
  return (
    <main className="pump-page pump-route-loading">
      <PumpInlineLoading label="Loading 0xPump" />
    </main>
  );
}

export function PumpErrorState({
  message,
  onRetry,
}: {
  message: string;
  onRetry?: () => void;
}) {
  return (
    <div className="pump-empty-state" role="alert">
      <span className="pump-eyebrow pump-danger">Data unavailable</span>
      <h2>Could not load 0xPump</h2>
      <p>{message}</p>
      {onRetry ? (
        <button className="pump-button pump-button-muted" type="button" onClick={onRetry}>
          Retry
        </button>
      ) : null}
    </div>
  );
}
