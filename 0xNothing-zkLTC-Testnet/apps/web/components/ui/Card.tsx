import type { HTMLAttributes } from "react";
import { cx } from "./cx";

export type CardVariant = "default" | "interactive" | "highlighted" | "danger";

const variants: Record<CardVariant, string> = {
  default: "",
  interactive: "transition-colors duration-[120ms] hover:border-line-strong",
  highlighted: "bg-accent-soft",
  danger: "border-negative/50",
};

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  variant?: CardVariant;
  padded?: boolean;
}

export function Card({ variant = "default", padded = true, className, ...rest }: CardProps) {
  return (
    <div
      className={cx("bg-surface-1 border border-line rounded-ui-lg shadow-e1 text-fg", padded && "p-4 sm:p-5", variants[variant], className)}
      {...rest}
    />
  );
}
