import type { ReactNode } from "react";
import { cx } from "./cx";

export interface StatItem {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  loading?: boolean;
}

export function StatGrid({ items, className }: { items: ReadonlyArray<StatItem>; className?: string }) {
  return (
    <dl className={cx("grid grid-cols-2 md:grid-cols-4 gap-px overflow-hidden rounded-ui-lg border border-line bg-line", className)}>
      {items.map((item) => (
        <div key={item.label} className="bg-surface-1 p-4">
          <dt className="font-ui text-xs font-medium text-fg-3">{item.label}</dt>
          <dd className="mt-1 font-num tnum text-lg text-fg" aria-busy={item.loading || undefined}>
            {item.loading ? <span className="skeleton inline-block h-5 w-20 rounded-ui-xs" /> : item.value}
          </dd>
          {item.hint ? <dd className="mt-0.5 font-ui text-xs text-fg-3">{item.hint}</dd> : null}
        </div>
      ))}
    </dl>
  );
}
