import type { ReactNode } from "react";
import { cx } from "./cx";

export type Tone = "default" | "positive" | "negative" | "warning" | "muted";

const toneClass: Record<Tone, string> = {
  default: "text-fg",
  positive: "text-positive",
  negative: "text-negative",
  warning: "text-warning",
  muted: "text-fg-3",
};

/** A label/value row. Pass `before` to render "before → value" with the tone on the new value. */
export function KeyValue({
  label, value, before, tone = "default", className,
}: { label: ReactNode; value: ReactNode; before?: ReactNode; tone?: Tone; className?: string }) {
  return (
    <div className={cx("flex items-baseline justify-between gap-4 py-1.5 font-ui text-[13px]", className)}>
      <dt className="text-fg-3">{label}</dt>
      <dd className="font-num tnum text-right">
        {before !== undefined ? (
          <>
            <span className="text-fg-2">{before}</span>
            <span aria-label="changes to" className="mx-1.5 text-fg-3">→</span>
          </>
        ) : null}
        <span className={toneClass[tone]}>{value}</span>
      </dd>
    </div>
  );
}

export function KeyValueList({ children, className }: { children: ReactNode; className?: string }) {
  return <dl className={cx("divide-y divide-line/60", className)}>{children}</dl>;
}
