"use client";

import type { AssetSymbol } from "@fi/config/assets";
import { TokenLogo } from "@fi/components/TokenLogo";

export function AmountField({
  id,
  label,
  asset,
  imageUrl,
  value,
  balance,
  helper,
  error,
  onChange,
  onMax,
  readOnly = false,
}: {
  id: string;
  label: string;
  asset: AssetSymbol | string;
  imageUrl?: string;
  value: string;
  balance?: string;
  helper?: string;
  error?: string;
  onChange?: (value: string) => void;
  onMax?: () => void;
  readOnly?: boolean;
}) {
  const helperId = helper ? `${id}-helper` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [helperId, errorId].filter(Boolean).join(" ") || undefined;

  return (
    <div className="fi-field">
      <div className="fi-field-label-row">
        <label htmlFor={id}>{label}</label>
        {balance ? <span title={`Balance ${balance}`}>Balance {balance}</span> : null}
      </div>
      <div className="fi-amount-input" data-invalid={Boolean(error) || undefined}>
        <input
          id={id}
          type="text"
          inputMode="decimal"
          autoComplete="off"
          spellCheck={false}
          value={value}
          readOnly={readOnly}
          aria-invalid={Boolean(error) || undefined}
          aria-describedby={describedBy}
          onChange={onChange ? (event) => onChange(event.target.value) : undefined}
          placeholder="0.0"
        />
        <div className="fi-amount-controls">
          <span className="fi-amount-asset" data-asset={asset === "LP" ? "lp" : undefined}>
            {asset !== "LP" ? <TokenLogo symbol={asset} imageUrl={imageUrl} size="sm" /> : null}
            <strong>{asset}</strong>
          </span>
          {onMax ? (
            <button className="fi-max-button" type="button" onClick={onMax} aria-label={`Use maximum ${asset} balance`}>
              MAX
            </button>
          ) : null}
        </div>
      </div>
      {helper ? <small id={helperId}>{helper}</small> : null}
      {error ? <small id={errorId} className="fi-field-error" aria-live="polite">{error}</small> : null}
    </div>
  );
}
