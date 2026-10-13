"use client";

import { useId } from "react";
import type { ReactNode } from "react";
import { cx } from "./cx";

export interface AmountPreset {
  label: string;
  onSelect: () => void;
}

export interface AmountFieldProps {
  label: string;
  value: string;
  onChange?: (value: string) => void;
  /** Token pill / selector rendered on the right. */
  token?: ReactNode;
  /** Secondary line under the number, e.g. "≈ $12.40". */
  fiat?: ReactNode;
  /** "Balance 12.3" style hint on the label row. */
  balance?: ReactNode;
  onMax?: () => void;
  presets?: ReadonlyArray<AmountPreset>;
  error?: ReactNode;
  readOnly?: boolean;
  loading?: boolean;
  disabled?: boolean;
  placeholder?: string;
  className?: string;
}

/** Accepts only a non-negative decimal string while typing. */
export function sanitizeDecimal(input: string): string | null {
  const normalized = input.replace(",", ".");
  return /^\d*\.?\d*$/.test(normalized) ? normalized : null;
}

export function AmountField({
  label, value, onChange, token, fiat, balance, onMax, presets, error, readOnly = false, loading = false,
  disabled = false, placeholder = "0.0", className,
}: AmountFieldProps) {
  const id = useId();
  const errorId = `${id}-error`;
  return (
    <div className={cx("grid gap-2", className)}>
      <div
        className={cx(
          "rounded-ui-lg border bg-surface-2 p-3.5 transition-colors duration-[120ms]",
          error ? "border-negative" : "border-line focus-within:border-accent",
        )}
      >
        <div className="flex items-center justify-between gap-2 font-ui text-xs">
          <label htmlFor={id} className="font-medium text-fg-3">{label}</label>
          <div className="flex items-center gap-2 text-fg-3">
            {balance ? <span className="font-num tnum">{balance}</span> : null}
            {onMax && !readOnly ? (
              <button
                type="button"
                onClick={onMax}
                disabled={disabled}
                className="h-6 min-w-6 px-1.5 rounded-ui-xs bg-accent-soft font-ui text-[11px] font-semibold text-accent-text focus-ring disabled:opacity-50"
              >
                MAX
              </button>
            ) : null}
          </div>
        </div>
        <div className="mt-1.5 flex items-center gap-3">
          {loading ? (
            <span className="skeleton h-8 flex-1 rounded-ui-sm" aria-hidden="true" />
          ) : (
            <input
              id={id}
              inputMode="decimal"
              autoComplete="off"
              spellCheck={false}
              value={value}
              readOnly={readOnly}
              disabled={disabled}
              placeholder={placeholder}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? errorId : undefined}
              onChange={(event) => {
                const next = sanitizeDecimal(event.target.value);
                if (next !== null) onChange?.(next);
              }}
              className="min-w-0 flex-1 bg-transparent font-num tnum text-[30px] leading-none text-fg outline-none placeholder:text-fg-disabled max-sm:text-2xl"
            />
          )}
          {token ? <div className="shrink-0">{token}</div> : null}
        </div>
        {fiat ? <div className="mt-1 font-num tnum text-xs text-fg-3">{fiat}</div> : null}
      </div>
      {presets && presets.length > 0 && !readOnly ? (
        <div className="flex flex-wrap gap-1.5">
          {presets.map((preset) => (
            <button
              key={preset.label}
              type="button"
              onClick={preset.onSelect}
              disabled={disabled}
              className="h-7 px-2.5 rounded-ui-sm border border-line bg-surface-2 font-num text-xs text-fg-2 hover:text-fg hover:border-line-strong focus-ring disabled:opacity-50"
            >
              {preset.label}
            </button>
          ))}
        </div>
      ) : null}
      {error ? <p id={errorId} className="font-ui text-xs text-negative">{error}</p> : null}
    </div>
  );
}
