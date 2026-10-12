import { healthBand, HEALTH_BAND_LABEL, type HealthBand } from "@/lib/risk";
import { cx } from "./cx";

const bandColor: Record<HealthBand, string> = {
  none: "text-fg-3",
  safe: "text-hf-safe",
  caution: "text-hf-caution",
  risk: "text-hf-risk",
  danger: "text-hf-liq",
  liquidatable: "text-hf-liq",
};

const bandFill: Record<HealthBand, string> = {
  none: "bg-surface-3",
  safe: "bg-hf-safe",
  caution: "bg-hf-caution",
  risk: "bg-hf-risk",
  danger: "bg-hf-liq",
  liquidatable: "bg-hf-liq",
};

/** Meter scale 1.0 → 3.0+, matching the spec ticks (1.0 · 1.25 · 1.5 · 2.0 · 3.0+). */
function meterPercent(hf: number): number {
  if (!Number.isFinite(hf)) return 100;
  return Math.min(100, Math.max(0, ((hf - 1) / 2) * 100));
}

export function formatHealthFactor(hf: number | null): string {
  if (hf === null) return "—";
  if (!Number.isFinite(hf)) return "∞";
  return hf >= 100 ? "99+" : hf.toFixed(2);
}

/** Numeric health factor with a coloured meter. `null` means no debt. */
export function HealthFactor({ value, meter = true, className }: { value: number | null; meter?: boolean; className?: string }) {
  const band = healthBand(value);
  const text = formatHealthFactor(value);
  return (
    <div className={cx("grid gap-2", className)}>
      <div className="flex items-baseline gap-2">
        <span className={cx("font-num tnum text-2xl font-semibold", bandColor[band])}>{text}</span>
        <span className={cx("font-ui text-xs font-medium", bandColor[band])}>{HEALTH_BAND_LABEL[band]}</span>
      </div>
      {meter ? (
        <div
          role="meter"
          aria-label="Health factor"
          aria-valuemin={1}
          aria-valuemax={3}
          aria-valuenow={value === null ? 3 : Math.min(3, Math.max(1, Number.isFinite(value) ? value : 3))}
          aria-valuetext={`Health factor ${text}, ${HEALTH_BAND_LABEL[band].toLowerCase()}`}
          className="relative h-2 rounded-full bg-surface-3"
        >
          <span className={cx("absolute inset-y-0 left-0 rounded-full", bandFill[band])} style={{ width: `${value === null ? 0 : meterPercent(value)}%` }} />
          {[1.25, 1.5, 2].map((tick) => (
            <span key={tick} aria-hidden="true" className="absolute inset-y-0 w-px bg-bg" style={{ left: `${meterPercent(tick)}%` }} />
          ))}
        </div>
      ) : null}
    </div>
  );
}
