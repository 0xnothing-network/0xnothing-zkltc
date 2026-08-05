"use client";

import { assetList, type AssetSymbol } from "@/config/assets";

export interface AssetSelectOption<T extends string = string> {
  value: T;
  symbol: string;
  name: string;
  badge?: string;
}

export function AssetSelect<T extends string = AssetSymbol>({
  id,
  label,
  value,
  options,
  entries,
  onChange,
}: {
  id: string;
  label: string;
  value: T;
  options?: readonly T[];
  entries?: readonly AssetSelectOption<T>[];
  onChange: (value: T) => void;
}) {
  const allowed: readonly AssetSelectOption<T>[] = entries ?? assetList
    .filter((asset) => !options || options.includes(asset.symbol as T))
    .map((asset) => ({ value: asset.symbol as T, symbol: asset.symbol, name: asset.name }));

  return (
    <label className="fi-select-field" htmlFor={id}>
      <span>{label}</span>
      <select id={id} value={value} onChange={(event) => onChange(event.target.value as T)}>
        {allowed.map((asset) => (
          <option value={asset.value} key={asset.value}>
            {asset.symbol} - {asset.name}{asset.badge ? ` · ${asset.badge}` : ""}
          </option>
        ))}
      </select>
    </label>
  );
}
