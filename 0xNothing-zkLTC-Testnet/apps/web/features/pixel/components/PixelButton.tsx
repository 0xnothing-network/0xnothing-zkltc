"use client";

import React from "react";

type Variant = "indigo" | "emerald" | "red" | "amber" | "secondary";
type Size = "default" | "sm" | "icon";

interface PixelButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  children: React.ReactNode;
}

const variantClass: Record<Variant, string> = {
  indigo: "pixel-btn pixel-btn-indigo",
  emerald: "pixel-btn pixel-btn-emerald",
  red: "pixel-btn pixel-btn-red",
  amber: "pixel-btn pixel-btn-amber",
  secondary: "pixel-btn pixel-btn-secondary",
};

const sizeClass: Record<Size, string> = {
  default: "",
  sm: "pixel-btn-sm",
  icon: "pixel-btn-icon",
};

export function PixelButton({
  variant = "secondary",
  size = "default",
  loading = false,
  children,
  className = "",
  disabled,
  ...props
}: PixelButtonProps) {
  const classes = [
    variantClass[variant],
    sizeClass[size],
    className,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <button {...props} className={classes} disabled={disabled || loading} aria-busy={loading || undefined}>
      {loading ? (
        <span className="inline-grid grid-cols-2 gap-[2px]" aria-hidden="true">
          <span className="h-1.5 w-1.5 bg-white/45 animate-pulse" />
          <span className="h-1.5 w-1.5 bg-white/80 animate-pulse [animation-delay:120ms]" />
          <span className="h-1.5 w-1.5 bg-white/80 animate-pulse [animation-delay:240ms]" />
          <span className="h-1.5 w-1.5 bg-white/45 animate-pulse [animation-delay:360ms]" />
        </span>
      ) : (
        children
      )}
    </button>
  );
}
