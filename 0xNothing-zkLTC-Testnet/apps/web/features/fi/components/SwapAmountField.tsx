"use client";

import { TokenLogo } from "@fi/components/TokenLogo";
import type { AssetSelectOption } from "@fi/components/AssetSelect";

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
  onAmountChange?: (value: string) => void;
  onAssetChange: (value: string) => void;
  onMax?: () => void;
  readOnly?: boolean;
}) {
  const helperId = helper ? `${id}-helper` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [helperId, errorId].filter(Boolean).join(" ") || undefined;
  const selectedAsset = assets.find((entry) => entry.value === assetValue);

  return (
    <div className="fi-field">
      <div className="fi-field-label-row">
        <label htmlFor={id}>{label}</label>
        {balance ? <span>Balance {balance}</span> : null}
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
          onChange={onAmountChange ? (event) => onAmountChange(event.target.value) : undefined}
          placeholder="0.0"
        />
        <span className="fi-amount-asset">
          <TokenLogo
            symbol={asset}
            imageUrl={selectedAsset?.imageUrl}
            size="sm"
            trustedCore={selectedAsset?.trustedCore !== false}
          />
          <label className="sr-only" htmlFor={assetSelectId}>{assetLabel}</label>
          <select
            id={assetSelectId}
            className="fi-compact-select"
            value={assetValue}
            onChange={(event) => onAssetChange(event.target.value)}
          >
            {assets.map((entry) => (
              <option value={entry.value} title={entry.name} key={entry.value}>
                {entry.symbol}{entry.detail ? ` · ${entry.detail}` : ""}{entry.badge ? ` · ${entry.badge}` : ""}
              </option>
            ))}
          </select>
        </span>
        {onMax ? (
          <button type="button" onClick={onMax} aria-label={`Use maximum ${asset} balance`}>
            MAX
          </button>
        ) : null}
      </div>
      {helper ? <small id={helperId}>{helper}</small> : null}
      {error ? <small id={errorId} className="fi-field-error" aria-live="polite">{error}</small> : null}
    </div>
  );
}
