import type { ReactNode } from "react";
import { cx } from "./cx";

export type BadgeTone = "neutral" | "trading" | "ready" | "graduated" | "risk" | "positive" | "warning";

const tones: Record<BadgeTone, string> = {
  neutral: "bg-surface-3 text-fg-2",
  trading: "bg-accent-soft text-accent-text",
  ready: "bg-warning-bg text-warning",
  graduated: "bg-info-bg text-info",
  risk: "bg-negative-bg text-negative",
  positive: "bg-positive-bg text-positive",
  warning: "bg-warning-bg text-warning",
};

/** Status badge with the 6px square "pixel" dot. Status is always carried by text. */
export function Badge({ tone = "neutral", children, className }: { tone?: BadgeTone; children: ReactNode; className?: string }) {
  return (
    <span className={cx("inline-flex items-center gap-1.5 h-6 px-2 rounded-ui-xs font-ui text-xs font-medium", tones[tone], className)}>
      <span aria-hidden="true" className="size-1.5 bg-current" />
      {children}
    </span>
  );
}
