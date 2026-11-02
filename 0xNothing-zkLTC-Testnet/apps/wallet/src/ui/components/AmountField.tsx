import { type ReactNode, useId } from "react";
import { t } from "../../core/i18n";
import { normalizeDecimalInput } from "../lib/decimalInput";

/**
 * The amount input, shaped like the site's: a wide numeric field, the symbol on
 * the right, the balance hint and MAX on a rule underneath. A locale decimal
 * comma is normalized, while malformed pasted text stays visible so
 * `parseAmount` can reject it instead of silently joining digit groups. The
 * value remains a string all the way through — a partially typed "0." must not
 * round-trip through a float.
 *
 * `inset` puts the label inside the box ("Pay with zkLTC", "From"), and
 * `symbol` may be a control — the swap screen passes its token picker there —
 * or `null` where the label already names the token (earn's "NUSD to stake").
 */
export function AmountField({
  label,
  value,
  onChange,
  symbol,
  onMax,
  hint,
  inset = false,
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
  inset?: boolean;
  invalid?: boolean;
  disabled?: boolean;
  autoFocus?: boolean;
}): ReactNode {
  const inputId = useId();
  const hintId = hint === undefined ? undefined : `${inputId}-hint`;
  return (
    <div className="w-field" data-inset={inset ? "true" : undefined}>
      {inset ? null : <label className="w-label" htmlFor={inputId}>{label}</label>}
      <div className="w-amount" data-invalid={invalid ? "true" : undefined}>
        {inset ? <label className="w-amount-label" htmlFor={inputId}>{label}</label> : null}
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
        {symbol === null ? null : <span className="w-amount-side">{symbol}</span>}
        {hint !== undefined || onMax ? (
          <div className="w-amount-foot">
            {hint === undefined ? <span /> : <span id={hintId} className="w-amount-hint">{hint}</span>}
            {onMax ? (
              <button type="button" className="w-max" onClick={onMax} disabled={disabled}>
                {t("common.max")}
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
