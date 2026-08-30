import { useEffect, useId, useMemo, useState, type ReactNode } from "react";
import { getAddress, isAddress, type Address } from "viem";
import type { WalletToken } from "../../config/assets";
import { t } from "../../core/i18n";
import { shortenAddress } from "../../core/lib/format";
import type { SwapMarketSource } from "../../core/services/marketCatalog";
import { useActionGate } from "../hooks/useActionGate";
import { TokenLogo } from "./TokenLogo";
import { VerifiedMark } from "./VerifiedMark";

export interface SwapTokenOption {
  token: WalletToken;
  source?: SwapMarketSource;
  /** Core assets 0, active Pump 1, liquid 0xFi 2, wallet-only import 3. */
  priority: 0 | 1 | 2 | 3;
}

function optionRank(option: SwapTokenOption, search: string): number {
  if (!search) return option.priority * 10;
  const symbol = option.token.symbol.toLowerCase();
  const name = option.token.name.toLowerCase();
  const address = option.token.address?.toLowerCase() ?? "";
  if (search === address || search === symbol || search === name) return 0;
  if (symbol.startsWith(search)) return 10 + option.priority;
  if (name.startsWith(search)) return 20 + option.priority;
  if (symbol.includes(search) || name.includes(search)) return 30 + option.priority;
  if (address.includes(search)) return 40 + option.priority;
  return Number.POSITIVE_INFINITY;
}

export function SwapTokenPicker({
  label,
  options,
  value,
  disabled = false,
  catalogLoading = false,
  catalogUnavailable = false,
  onSelect,
  onImport,
}: {
  label: string;
  options: readonly SwapTokenOption[];
  value: WalletToken;
  disabled?: boolean;
  catalogLoading?: boolean;
  catalogUnavailable?: boolean;
  onSelect: (option: SwapTokenOption) => Promise<boolean>;
  onImport: (address: Address) => Promise<boolean>;
}): ReactNode {
  const searchId = useId();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [choosing, setChoosing] = useState(false);
  const actionGate = useActionGate();
  const normalized = query.trim().replace(/^\$/u, "").toLowerCase();
  const exactAddress = isAddress(query.trim()) ? getAddress(query.trim()) : null;
  const exactListed = exactAddress !== null && options.some(
    (option) => option.token.address?.toLowerCase() === exactAddress.toLowerCase(),
  );

  const visible = useMemo(() => options
    .map((option) => ({ option, rank: optionRank(option, normalized) }))
    .filter((entry) => Number.isFinite(entry.rank))
    .sort((left, right) =>
      left.rank - right.rank
      || left.option.token.symbol.localeCompare(right.option.token.symbol)
      || left.option.token.id.localeCompare(right.option.token.id)
    )
    .slice(0, 80)
    .map((entry) => entry.option), [normalized, options]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape" && !choosing) setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [choosing, open]);

  const choose = async (option: SwapTokenOption): Promise<void> => {
    if (choosing || disabled || !actionGate.tryEnter()) return;
    setChoosing(true);
    try {
      if (await onSelect(option)) {
        setOpen(false);
        setQuery("");
      }
    } finally {
      actionGate.leave();
      setChoosing(false);
    }
  };

  const importAddress = async (address: Address): Promise<void> => {
    if (choosing || disabled || !actionGate.tryEnter()) return;
    setChoosing(true);
    try {
      if (await onImport(address)) {
        setOpen(false);
        setQuery("");
      }
    } finally {
      actionGate.leave();
      setChoosing(false);
    }
  };

  return (
    <div className="w-field">
      <span className="w-label">{label}</span>
      <button
        type="button"
        className="w-token-trigger"
        disabled={disabled}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => {
          setQuery("");
          setOpen(true);
        }}
      >
        <TokenLogo token={value} size={32} />
        <span className="w-token-trigger-copy">
          <strong className="w-token-symbol">
            {value.symbol}
            <VerifiedMark verified={value.verified} />
          </strong>
          <span>{value.name}</span>
        </span>
        <span className="w-token-trigger-caret" aria-hidden="true">⌄</span>
      </button>

      {open ? (
        <div
          className="w-sheet"
          onClick={() => {
            if (!choosing) setOpen(false);
          }}
        >
          <div
            className="w-sheet-body w-token-sheet"
            role="dialog"
            aria-modal="true"
            aria-labelledby={searchId}
            aria-busy={choosing}
            onClick={(event) => event.stopPropagation()}
          >
            <header className="w-sheet-head">
              <span id={searchId}>{t("swap.searchToken")}</span>
              <button
                type="button"
                className="w-back"
                disabled={choosing}
                aria-label={t("common.close")}
                onClick={() => setOpen(false)}
              >
                ✕
              </button>
            </header>
            <div className="w-token-search">
              <input
                className="w-input"
                type="search"
                value={query}
                autoFocus
                spellCheck={false}
                autoComplete="off"
                placeholder={t("swap.searchPlaceholder")}
                onChange={(event) => setQuery(event.target.value)}
              />
              {catalogLoading ? <span className="w-hint">{t("swap.catalogLoading")}</span> : null}
              {catalogUnavailable ? <span className="w-hint" data-tone="warn">{t("swap.catalogUnavailable")}</span> : null}
            </div>
            <div className="w-token-options" role="listbox" aria-label={label}>
              {exactAddress !== null && !exactListed ? (
                <button
                  type="button"
                  className="w-token-option"
                  disabled={choosing}
                  onClick={() => void importAddress(exactAddress)}
                >
                  <span className="w-token-ca" aria-hidden="true">CA</span>
                  <span className="w-token-option-copy">
                    <strong>{t("tok.add")}</strong>
                    <span>{shortenAddress(exactAddress, 8, 6)}</span>
                  </span>
                  <span className="w-token-source">CA</span>
                </button>
              ) : null}
              {visible.map((option) => (
                <button
                  key={option.token.id}
                  type="button"
                  className="w-token-option"
                  role="option"
                  aria-selected={option.token.id === value.id}
                  disabled={choosing}
                  onClick={() => void choose(option)}
                >
                  <TokenLogo token={option.token} size={32} />
                  <span className="w-token-option-copy">
                    <strong className="w-token-symbol">
                      {option.token.symbol}
                      <VerifiedMark verified={option.token.verified} />
                    </strong>
                    <span>{option.token.name}</span>
                  </span>
                  <span
                    className="w-token-source"
                    data-core={option.token.verified ? "true" : undefined}
                  >
                    {option.token.verified ? "CORE" : option.source ?? (option.token.address
                      ? shortenAddress(option.token.address, 4, 3)
                      : "CORE")}
                  </span>
                </button>
              ))}
              {visible.length === 0 && exactAddress === null ? (
                <div className="w-empty">{t("swap.noTokenMatch")}</div>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
