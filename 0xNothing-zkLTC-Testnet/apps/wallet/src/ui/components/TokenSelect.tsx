import { type ReactNode, useId } from "react";
import type { WalletToken } from "../../config/assets";

/**
 * Token picker. A native `<select>` on purpose: it is the one control that a
 * 360px popup, a phone keyboard and a screen reader all already agree on, and it
 * costs nothing to draw.
 */
export function TokenSelect({
  label,
  tokens,
  value,
  onChange,
  disabled = false,
}: {
  label: string;
  tokens: readonly WalletToken[];
  value: WalletToken;
  onChange: (next: WalletToken) => void;
  disabled?: boolean;
}): ReactNode {
  const selectId = useId();
  return (
    <div className="w-field">
      <label className="w-label" htmlFor={selectId}>{label}</label>
      <select
        id={selectId}
        className="w-select"
        value={value.id}
        disabled={disabled}
        aria-label={label}
        onChange={(event) => {
          const next = tokens.find((token) => token.id === event.target.value);
          if (next) onChange(next);
        }}
      >
        {tokens.map((token) => (
          <option key={token.id} value={token.id}>
            {token.symbol} — {token.name}
          </option>
        ))}
      </select>
    </div>
  );
}
