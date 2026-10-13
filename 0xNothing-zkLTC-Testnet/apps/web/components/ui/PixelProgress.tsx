import { cx } from "./cx";

/** Clamp to [0, 100] and map to a filled segment count. Exported for tests. */
export function filledSegments(percent: number, segments: number): number {
  if (!Number.isFinite(percent) || segments <= 0) return 0;
  const clamped = Math.min(100, Math.max(0, percent));
  return Math.round((clamped / 100) * segments);
}

/** Segmented pixel progress bar — the Silver Standard signature motif. */
export function PixelProgress({
  value, label = "to READY", segments = 40, size = "sm", className,
}: { value: number; label?: string; segments?: number; size?: "sm" | "lg"; className?: string }) {
  const filled = filledSegments(value, segments);
  const pct = Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : 0;
  return (
    <div
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(pct)}
      aria-valuetext={`${Math.round(pct)}% ${label}`}
      className={cx("grid gap-[2px]", size === "lg" ? "h-3" : "h-2", className)}
      style={{ gridTemplateColumns: `repeat(${segments}, minmax(0, 1fr))` }}
    >
      {Array.from({ length: segments }, (_, index) => (
        <span key={index} className={index < filled ? "bg-accent" : "bg-surface-3"} />
      ))}
    </div>
  );
}
