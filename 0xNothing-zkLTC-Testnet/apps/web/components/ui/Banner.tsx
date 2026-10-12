import type { ReactNode } from "react";
import { cx } from "./cx";

export type BannerTone = "warning" | "error" | "info";

const tones: Record<BannerTone, string> = {
  warning: "bg-warning-bg text-warning border-warning/30",
  error: "bg-negative-bg text-negative border-negative/30",
  info: "bg-info-bg text-info border-info/30",
};

/** Full-width notice under the header (wrong network, paused contracts, indexer lag). */
export function Banner({ tone = "info", title, children, action, className }: {
  tone?: BannerTone; title: ReactNode; children?: ReactNode; action?: ReactNode; className?: string;
}) {
  return (
    <div role={tone === "error" ? "alert" : "status"} className={cx("border-y", tones[tone], className)}>
      <div className="mx-auto flex max-w-[1280px] flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2.5 sm:px-6">
        <p className="font-ui text-sm">
          <strong className="font-semibold">{title}</strong>
          {children ? <span className="text-fg-2"> {children}</span> : null}
        </p>
        {action ? <div className="ml-auto">{action}</div> : null}
      </div>
    </div>
  );
}
