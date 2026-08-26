"use client";

import type { AssetSelectOption } from "@fi/components/AssetSelect";
import { SwapAssetSelect } from "@fi/components/SwapAssetSelect";

export function SwapAmountField({
  id,
  assetSelectId,
  label,
  assetLabel,
  asset,
  assetValue,
  assets,
  value,
  balance,
  helper,
  error,
  busy = false,
  onAmountChange,
  onAssetChange,
  onMax,
  readOnly = false,
}: {
  id: string;
  assetSelectId: string;
  label: string;
  assetLabel: string;
  asset: string;
  assetValue: string;
  assets: readonly AssetSelectOption<string>[];
  value: string;
  balance?: string;
  helper?: string;
  error?: string;
  busy?: boolean;
  onAmountChange?: (value: string) => void;
  onAssetChange: (value: string) => void;
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
      <div
        className="fi-amount-input"
        data-busy={busy || undefined}
        data-invalid={Boolean(error) || undefined}
        aria-busy={busy || undefined}
      >
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
          onChange={onAmountChange ? (event) => onAmountChange(event.target.value) : undefined}
          placeholder="0.0"
        />
        {busy ? <span className="fi-amount-quote-skeleton" aria-hidden="true" /> : null}
        <div className="fi-amount-controls fi-amount-controls-select">
          <SwapAssetSelect
            id={assetSelectId}
            label={assetLabel}
            value={assetValue}
            assets={assets}
            onChange={onAssetChange}
          />
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
