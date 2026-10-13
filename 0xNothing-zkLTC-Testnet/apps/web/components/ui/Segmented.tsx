"use client";

import { cx } from "./cx";

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
  disabled?: boolean;
  /** Shown as title when disabled, so the reason is discoverable. */
  disabledReason?: string;
}

export interface SegmentedProps<T extends string> {
  label: string;
  value: T;
  options: ReadonlyArray<SegmentedOption<T>>;
  onChange: (value: T) => void;
  /** "trade" colours the first option green (buy) and the second red (sell). */
  variant?: "default" | "trade";
  className?: string;
}

export function Segmented<T extends string>({ label, value, options, onChange, variant = "default", className }: SegmentedProps<T>) {
  return (
    <div role="group" aria-label={label} className={cx("grid auto-cols-fr grid-flow-col gap-1 p-1 rounded-ui-md bg-surface-2 border border-line", className)}>
      {options.map((option, index) => {
        const on = option.value === value;
        const tradeTone = variant === "trade" ? (index === 0 ? "bg-positive text-[#04130B]" : "bg-negative text-[#1F0308]") : "bg-surface-3 text-fg shadow-e1";
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={on}
            disabled={option.disabled}
            title={option.disabled ? option.disabledReason : undefined}
            onClick={() => onChange(option.value)}
            className={cx(
              "h-9 min-w-0 px-3 rounded-ui-sm font-ui text-sm font-medium transition-colors duration-[120ms] focus-ring disabled:text-fg-disabled disabled:cursor-not-allowed",
              on ? tradeTone : "text-fg-2 hover:text-fg",
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
