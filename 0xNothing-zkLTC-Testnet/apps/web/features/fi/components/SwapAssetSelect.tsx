"use client";

import { useEffect, useRef, useState } from "react";
import { CaretDown, Check, MagnifyingGlass, X } from "@phosphor-icons/react";
import type { AssetSelectOption } from "@fi/components/AssetSelect";
import { TokenLogo } from "@fi/components/TokenLogo";
import { useImportedSwapAsset } from "@fi/lib/hooks/useImportedSwapAsset";

export function SwapAssetSelect({ id, label, value, assets, onChange, onAddressSelect }: {
  id: string;
  label: string;
  value: string;
  assets: readonly AssetSelectOption<string>[];
  onChange: (value: string) => void;
  onAddressSelect?: (address: string) => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const query = search.trim();
  const isContractSearch = /^0x/i.test(query);
  const imported = useImportedSwapAsset(query, open && isContractSearch && Boolean(onAddressSelect));
  const selected = assets.find((asset) => asset.value === value);
  const results: readonly AssetSelectOption<string>[] = isContractSearch && onAddressSelect
    ? imported.status === "ready" && imported.asset
      ? [{ value: imported.asset.id, symbol: imported.asset.symbol, name: imported.asset.name,
          imageUrl: imported.asset.imageUrl, trustedCore: imported.asset.trustedCore,
          detail: imported.address, badge: imported.asset.trustedCore ? undefined : "Imported" }]
      : []
    : assets.filter((asset) => [asset.symbol, asset.name, asset.detail, asset.value]
      .some((text) => text?.toLowerCase().includes(query.toLowerCase())));
  const listboxId = `${id}-listbox`;
  const statusId = `${id}-search-status`;
  const currentIndex = Math.min(activeIndex, Math.max(0, results.length - 1));

  useEffect(() => {
    if (!open) return;
    searchRef.current?.focus();
    const outside = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);

  useEffect(() => {
    if (open) document.getElementById(`${id}-option-${currentIndex}`)?.scrollIntoView({ block: "nearest" });
  }, [currentIndex, id, open]);

  function close(restore = false) {
    setOpen(false);
    if (restore) requestAnimationFrame(() => triggerRef.current?.focus());
  }
  function show() {
    setSearch("");
    setActiveIndex(0);
    setOpen(true);
  }
  function choose(index: number) {
    const next = results[index];
    if (!next) return;
    if (isContractSearch && onAddressSelect) {
      if (imported.status !== "ready" || !imported.address) return;
      onAddressSelect(imported.address);
    } else if (next.value !== value) onChange(next.value);
    close(true);
  }
  const message = isContractSearch && onAddressSelect
    ? imported.status === "loading" ? "Looking up token…"
      : imported.status === "ready" ? "Check the contract address before selecting."
      : imported.error ?? "Enter a complete 0x contract address."
    : results.length ? `${results.length} ${results.length === 1 ? "token" : "tokens"}` : "No tokens found. Try another name or paste a contract address.";

  return (
    <div className="fi-swap-asset-select" ref={rootRef} onBlur={(event) => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) close();
    }}>
      <button ref={triggerRef} id={id} type="button" className="fi-swap-asset-trigger"
        aria-label={`${label}: ${selected?.symbol ?? value}`} aria-haspopup="dialog"
        aria-expanded={open} aria-controls={`${id}-picker`} disabled={!selected}
        onClick={() => open ? close() : show()}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); show(); }
        }}>
        {selected ? <><TokenLogo symbol={selected.symbol} imageUrl={selected.imageUrl} size="sm" trustedCore={selected.trustedCore !== false} />
          <span className="fi-swap-asset-symbol">{selected.symbol}</span></> : <span>--</span>}
        <CaretDown size={13} weight="bold" aria-hidden="true" />
      </button>
      {open ? (
        <div id={`${id}-picker`} className="fi-swap-asset-picker" role="dialog" aria-label={`Select ${label.toLowerCase()}`}
          onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); close(true); } }}>
          <div className="fi-swap-asset-picker-heading"><strong>{label}</strong>
            <button type="button" aria-label={`Close ${label.toLowerCase()} selector`} onClick={() => close(true)}><X size={16} /></button>
          </div>
          <div className="fi-swap-asset-search">
            <MagnifyingGlass size={17} aria-hidden="true" />
            <input ref={searchRef} type="text" role="combobox" aria-label={`Search ${label.toLowerCase()}`}
              aria-expanded={open} aria-autocomplete="list" aria-controls={listboxId} aria-describedby={statusId}
              aria-activedescendant={results.length ? `${id}-option-${currentIndex}` : undefined}
              autoComplete="off" autoCapitalize="none" spellCheck={false}
              placeholder="Name, symbol or paste CA" value={search}
              onChange={(event) => { setSearch(event.target.value); setActiveIndex(0); }}
              onKeyDown={(event) => {
                if (event.key === "Enter") { event.preventDefault(); choose(currentIndex); }
                if ((event.key === "ArrowDown" || event.key === "ArrowUp") && results.length) {
                  event.preventDefault();
                  setActiveIndex((currentIndex + (event.key === "ArrowDown" ? 1 : -1) + results.length) % results.length);
                }
              }} />
          </div>
          <p id={statusId} className="fi-swap-asset-search-status" role="status">{message}</p>
          <div id={listboxId} className="fi-swap-asset-results" role="listbox" aria-label={`${label} options`}>
            {results.map((asset, index) => {
              const isSelected = asset.value === value;
              return <div id={`${id}-option-${index}`} className="fi-swap-asset-option" key={asset.value}
                role="option" tabIndex={-1} onMouseDown={(event) => event.preventDefault()} aria-selected={isSelected} data-active={currentIndex === index || undefined}
                data-selected={isSelected || undefined} onClick={() => choose(index)}
                onPointerMove={() => setActiveIndex(index)}>
                <TokenLogo symbol={asset.symbol} imageUrl={asset.imageUrl} size="sm" trustedCore={asset.trustedCore !== false} />
                <span className="fi-swap-asset-option-copy"><strong>{asset.symbol}</strong>
                  <small>{asset.name}</small>{asset.detail ? <small className="fi-swap-asset-address">{asset.detail}</small> : null}</span>
                {asset.badge ? <span className="fi-swap-asset-badge">{asset.badge}</span> : null}
                <Check className="fi-swap-asset-check" size={14} weight="bold" aria-hidden="true" />
              </div>;
            })}
          </div>
        </div>
      ) : null}
    </div>
  );
}
