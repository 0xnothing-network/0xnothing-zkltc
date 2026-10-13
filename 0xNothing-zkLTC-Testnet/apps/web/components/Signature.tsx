/*
 * Signature components of the 0xNothing design system (styles: app/signature.css).
 * They read the product accent and shared status colours from tokens.css.
 */

/** Pixel-cell progress bar. `value` is clamped to 0–1; cells fill left to right. */
export function PixelProgress({ value, cells = 32, label, className = "" }: { value: number; cells?: number; label: string; className?: string }) {
  const clamped = Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
  const filled = Math.round(clamped * cells);
  return (
    <div className={`ox-pixel-progress ${className}`.trim()} role="progressbar" aria-label={label}
      aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(clamped * 100)}>
      {Array.from({ length: cells }, (_, index) => <i key={index} data-on={index < filled ? "" : undefined} />)}
    </div>
  );
}

/**
 * Semicircular health gauge. `risk` is the position's distance to liquidation
 * on a 0–1 scale (0 = no debt, 1 = liquidation threshold reached); zones switch
 * from positive to warning to negative at `warnAt` and `dangerAt`.
 */
export function HealthGauge({ risk, value, caption, warnAt = .85, dangerAt = 1 }: {
  risk: number | undefined;
  value: string;
  caption: string;
  warnAt?: number;
  dangerAt?: number;
}) {
  const known = risk !== undefined && Number.isFinite(risk);
  const clamped = known ? Math.min(1, Math.max(0, risk)) : 0;
  const state = !known ? "unknown" : clamped >= dangerAt ? "danger" : clamped >= warnAt ? "warning" : "healthy";
  // Arc length of a 180° arc with r = 50 is 50π.
  const arc = Math.PI * 50;
  return (
    <figure className="ox-health-gauge" data-state={state} aria-label={`${caption}: ${value}`}>
      <svg viewBox="0 0 120 68" aria-hidden="true">
        <path className="ox-health-track" d="M10 62 A50 50 0 0 1 110 62" pathLength={arc} />
        <path className="ox-health-fill" d="M10 62 A50 50 0 0 1 110 62" pathLength={arc} strokeDasharray={`${clamped * arc} ${arc}`} />
      </svg>
      <figcaption>
        <strong>{value}</strong>
        <span>{caption}</span>
      </figcaption>
    </figure>
  );
}

/** Numbered steps of a multi-transaction flow (approve → confirm → done). */
export function TxSteps({ step, total, failed = false, done = false }: { step: number; total: number; failed?: boolean; done?: boolean }) {
  if (!Number.isSafeInteger(total) || total < 2) return null;
  return (
    <ol className="ox-tx-steps" aria-label={`Step ${Math.min(step, total)} of ${total}`}>
      {Array.from({ length: total }, (_, index) => {
        const number = index + 1;
        const state = done || number < step ? "complete" : number === step ? (failed ? "failed" : "active") : "pending";
        return <li key={number} data-state={state}><span>{number}</span></li>;
      })}
    </ol>
  );
}
