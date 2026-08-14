"use client";

import { useEffect, useRef, useState } from "react";
import { CaretDown, Check } from "@phosphor-icons/react";
import type { AssetSelectOption } from "@fi/components/AssetSelect";
import { TokenLogo } from "@fi/components/TokenLogo";

function optionLabel(option: AssetSelectOption<string>): string {
  return [option.symbol, option.name, option.detail, option.badge].filter(Boolean).join(" ").toLowerCase();
}

export function SwapAssetSelect({
  id,
  label,
  value,
  assets,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  assets: readonly AssetSelectOption<string>[];
  onChange: (value: string) => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listboxRef = useRef<HTMLDivElement>(null);
  const typeaheadRef = useRef("");
  const typeaheadTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [open, setOpen] = useState(false);
  const selectedIndex = Math.max(0, assets.findIndex((asset) => asset.value === value));
  const [activeIndex, setActiveIndex] = useState(selectedIndex);
  const selected = assets.find((asset) => asset.value === value);
  const listboxId = `${id}-listbox`;

  useEffect(() => {
    if (!open) return;

    function closeOnOutsidePointer(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    }

    document.addEventListener("pointerdown", closeOnOutsidePointer);
    return () => document.removeEventListener("pointerdown", closeOnOutsidePointer);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    setActiveIndex(selectedIndex);
    listboxRef.current?.focus();
  }, [open, selectedIndex]);

  useEffect(() => {
    if (!open) return;
    document.getElementById(`${id}-option-${activeIndex}`)?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, id, open]);

  useEffect(() => {
    if (assets.length > 0 && activeIndex >= assets.length) setActiveIndex(assets.length - 1);
  }, [activeIndex, assets.length]);

  useEffect(() => () => {
    if (typeaheadTimerRef.current) clearTimeout(typeaheadTimerRef.current);
  }, []);

  function close(restoreTrigger = false) {
    setOpen(false);
    if (restoreTrigger) requestAnimationFrame(() => triggerRef.current?.focus());
  }

  function choose(index: number) {
    const next = assets[index];
    if (!next) return;
    if (next.value !== value) onChange(next.value);
    close(true);
  }

  function moveActive(step: number) {
    if (assets.length === 0) return;
    setActiveIndex((current) => (current + step + assets.length) % assets.length);
  }

  function openFromTrigger(event: React.KeyboardEvent<HTMLButtonElement>) {
    if (!["ArrowDown", "ArrowUp", "Enter", " "].includes(event.key)) return;
    event.preventDefault();
    if (assets.length === 0) return;
    setActiveIndex(selectedIndex);
    setOpen(true);
  }

  function handleListboxKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      moveActive(1);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      moveActive(-1);
      return;
    }
    if (event.key === "Home") {
      event.preventDefault();
      setActiveIndex(0);
      return;
    }
    if (event.key === "End") {
      event.preventDefault();
      setActiveIndex(Math.max(0, assets.length - 1));
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      choose(activeIndex);
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      close(true);
      return;
    }
    if (event.key === "Tab") {
      setOpen(false);
      return;
    }
    if (event.key.length !== 1 || event.ctrlKey || event.metaKey || event.altKey) return;

    typeaheadRef.current += event.key.toLowerCase();
    if (typeaheadTimerRef.current) clearTimeout(typeaheadTimerRef.current);
    typeaheadTimerRef.current = setTimeout(() => {
      typeaheadRef.current = "";
    }, 600);
    const matchIndex = assets.findIndex((asset) => optionLabel(asset).startsWith(typeaheadRef.current));
    if (matchIndex >= 0) setActiveIndex(matchIndex);
  }

  return (
    <div className="fi-swap-asset-select" ref={rootRef}>
      <button
        ref={triggerRef}
        id={id}
        type="button"
        className="fi-swap-asset-trigger"
        aria-label={`${label}: ${selected?.symbol ?? value}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listboxId}
        disabled={!selected}
        onClick={() => setOpen((current) => !current)}
        onKeyDown={openFromTrigger}
      >
        {selected ? (
          <>
            <TokenLogo
              symbol={selected.symbol}
              imageUrl={selected.imageUrl}
              size="sm"
              trustedCore={selected.trustedCore !== false}
            />
            <span className="fi-swap-asset-symbol">{selected.symbol}</span>
          </>
        ) : <span>--</span>}
        <CaretDown size={13} weight="bold" aria-hidden="true" />
      </button>

      {open ? (
        <div
          ref={listboxRef}
          id={listboxId}
          className="fi-swap-asset-listbox"
          role="listbox"
          tabIndex={-1}
          aria-label={`${label} options`}
          aria-activedescendant={assets.length ? `${id}-option-${Math.min(activeIndex, assets.length - 1)}` : undefined}
          onKeyDown={handleListboxKeyDown}
        >
          {assets.map((asset, index) => {
            const isSelected = asset.value === value;
            const showDetail = Boolean(asset.detail && !asset.name.includes(asset.detail));
            return (
              <div
                id={`${id}-option-${index}`}
                className="fi-swap-asset-option"
                data-active={activeIndex === index || undefined}
                data-selected={isSelected || undefined}
                role="option"
                aria-selected={isSelected}
                key={asset.value}
                onClick={() => choose(index)}
                onPointerMove={() => setActiveIndex(index)}
              >
                <TokenLogo
                  symbol={asset.symbol}
                  imageUrl={asset.imageUrl}
                  size="sm"
                  trustedCore={asset.trustedCore !== false}
                />
                <span className="fi-swap-asset-option-copy">
                  <strong>{asset.symbol}</strong>
                  <small>{asset.name}{showDetail ? ` / ${asset.detail}` : ""}</small>
                </span>
                {asset.badge ? <span className="fi-swap-asset-badge">{asset.badge}</span> : null}
                <Check className="fi-swap-asset-check" size={14} weight="bold" aria-hidden="true" />
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
