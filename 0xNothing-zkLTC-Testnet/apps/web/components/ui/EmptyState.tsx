import type { ReactNode } from "react";
import { cx } from "./cx";

/** Empty / error state: glyph, title, one-line reason, one action. */
export function EmptyState({
  title, reason, action, glyph = "[ 0x∅ ]", className,
}: { title: string; reason?: ReactNode; action?: ReactNode; glyph?: string; className?: string }) {
  return (
    <div className={cx("flex flex-col items-center gap-2 py-10 px-4 text-center", className)}>
      <span aria-hidden="true" className="font-brand text-lg text-fg-3">{glyph}</span>
      <p className="font-ui text-base font-semibold text-fg">{title}</p>
      {reason ? <p className="max-w-sm font-ui text-sm text-fg-2">{reason}</p> : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}
