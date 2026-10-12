import { cx } from "./cx";

export function Skeleton({ className }: { className?: string }) {
  return <span aria-hidden="true" className={cx("skeleton block rounded-ui-xs h-4", className)} />;
}
