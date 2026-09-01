import { type ReactNode, useId } from "react";
import { t } from "../../core/i18n";
import { normalizeDecimalInput } from "../lib/decimalInput";

/**
 * The amount input, shaped like the site's: a wide numeric field, the symbol on
 * the right, MAX at the end. A locale decimal comma is normalized, while
 * malformed pasted text stays visible so `parseAmount` can reject it instead
 * of silently joining digit groups. The value remains a string all the way
 * through — a partially typed "0." must not round-trip through a float.
 */
export function AmountField({
  label,
  value,
  onChange,
  symbol,
  onMax,
  hint,
  invalid = false,
  disabled = false,
  autoFocus = false,
}: {
  label: string;
  value: string;
  onChange: (next: string) => void;
  symbol: ReactNode;
  onMax?: () => void;
  hint?: ReactNode;
  invalid?: boolean;
  disabled?: boolean;
  autoFocus?: boolean;
}): ReactNode {
  const inputId = useId();
  const hintId = hint === undefined ? undefined : `${inputId}-hint`;
  return (
    <div className="w-field">
      <label className="w-label" htmlFor={inputId}>{label}</label>
      <span className="w-amount">
        <input
          id={inputId}
          value={value}
          onChange={(event) => onChange(normalizeDecimalInput(event.target.value))}
          inputMode="decimal"
          autoComplete="off"
          spellCheck={false}
          placeholder="0.0"
          disabled={disabled}
          autoFocus={autoFocus}
          aria-label={label}
          aria-invalid={invalid || undefined}
          aria-describedby={hintId}
        />
        <span className="w-amount-side">{symbol}</span>
        {onMax ? (
          <button type="button" className="w-max" onClick={onMax} disabled={disabled}>
            {t("common.max")}
          </button>
        ) : null}
      </span>
      {hint === undefined ? null : <span id={hintId} className="w-hint">{hint}</span>}
    </div>
  );
}
