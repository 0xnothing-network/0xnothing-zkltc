"use client";

import type { ButtonHTMLAttributes } from "react";
import { cx } from "./cx";

export interface ChipProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  on?: boolean;
}

/** Filter/toggle chip. "on" is inverted (text-1 background). */
export function Chip({ on = false, className, type = "button", ...rest }: ChipProps) {
  return (
    <button
      type={type}
      aria-pressed={on}
      className={cx(
        "inline-flex items-center h-8 px-3 rounded-full font-ui text-[13px] font-medium border transition-colors duration-[120ms] focus-ring",
        on ? "bg-fg text-bg border-fg" : "bg-surface-2 text-fg-2 border-line hover:text-fg hover:border-line-strong",
        className,
      )}
      {...rest}
    />
  );
}
