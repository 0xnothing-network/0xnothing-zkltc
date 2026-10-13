"use client";

import { forwardRef } from "react";
import type { ButtonHTMLAttributes } from "react";
import { cx } from "./cx";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "buy" | "sell" | "warning" | "danger";
export type ButtonSize = "sm" | "md" | "lg";

const base =
  "inline-flex items-center justify-center gap-2 font-ui font-medium whitespace-nowrap select-none " +
  "transition-[background-color,border-color,color,transform] duration-[120ms] ease-ui active:translate-y-px " +
  "focus-ring disabled:cursor-not-allowed aria-disabled:cursor-not-allowed";

const variants: Record<ButtonVariant, string> = {
  primary: "bg-accent text-accent-ink hover:bg-accent-hover",
  secondary: "bg-surface-2 text-fg border border-line-strong hover:bg-surface-3",
  ghost: "bg-transparent text-fg-2 hover:bg-surface-3 hover:text-fg",
  buy: "bg-positive text-[#04130B] hover:brightness-110",
  sell: "bg-negative text-[#1F0308] hover:brightness-110",
  warning: "bg-warning text-[#1F1400] hover:brightness-110",
  danger: "bg-transparent text-negative border border-negative/50 hover:bg-negative-bg",
};

const disabledLook =
  "disabled:bg-surface-2 disabled:text-fg-disabled disabled:border-transparent disabled:hover:bg-surface-2 disabled:active:translate-y-0 " +
  "aria-disabled:bg-surface-2 aria-disabled:text-fg-disabled aria-disabled:border-transparent";

const sizes: Record<ButtonSize, string> = {
  sm: "h-8 px-3 text-[13px] rounded-ui-sm",
  md: "h-10 px-4 text-sm rounded-ui-md",
  lg: "h-[52px] px-5 text-base rounded-ui-md",
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Shows a spinner and sets aria-busy; the label stays for screen readers. */
  loading?: boolean;
  block?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "primary", size = "md", loading = false, block = false, className, children, type = "button", disabled, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled}
      aria-busy={loading || undefined}
      className={cx(base, variants[variant], disabledLook, sizes[size], block && "w-full", className)}
      {...rest}
    >
      {loading ? <Spinner /> : null}
      {children}
    </button>
  );
});

export function Spinner({ className }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cx("inline-block size-4 rounded-full border-2 border-current border-r-transparent animate-spin motion-reduce:animate-none", className)}
    />
  );
}
