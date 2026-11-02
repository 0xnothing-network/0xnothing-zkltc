import { type ReactNode, useId } from "react";
import type { WalletToken } from "../../config/assets";
import { Icon } from "./kit";
import { TokenLogo } from "./TokenLogo";

/**
 * Token picker. A native `<select>` on purpose: it is the one control that a
 * 360px popup, a phone keyboard and a screen reader all already agree on, and it
 * costs nothing to draw. It sits transparent over a drawn face — the token's
 * mark and symbol — so the look matches the rest of the form. `meta` takes the
 * token name's place on the right of the face (the send screen puts the balance
 * there).
 */
export function TokenSelect({
  label,
  tokens,
  value,
  onChange,
  meta,
  disabled = false,
}: {
  label: string;
  tokens: readonly WalletToken[];
  value: WalletToken;
  onChange: (next: WalletToken) => void;
  meta?: ReactNode;
  disabled?: boolean;
}): ReactNode {
  const selectId = useId();
  return (
    <div className="w-field">
      <label className="w-label" htmlFor={selectId}>{label}</label>
      <div className="w-token-select" data-disabled={disabled ? "true" : undefined}>
        <span className="w-token-select-face" aria-hidden="true">
          <TokenLogo token={value} size={24} />
          <strong>{value.symbol}</strong>
          {meta === undefined
            ? <span>{value.name}</span>
            : <span id={`${selectId}-meta`} className="w-token-select-meta">{meta}</span>}
          <Icon name="caret" size={16} />
        </span>
        <select
          id={selectId}
          className="w-token-select-native"
          value={value.id}
          disabled={disabled}
          aria-label={label}
          aria-describedby={meta === undefined ? undefined : `${selectId}-meta`}
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
    </div>
  );
}
