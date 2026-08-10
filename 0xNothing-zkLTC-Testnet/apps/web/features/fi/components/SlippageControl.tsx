"use client";

export function SlippageControl({ value, onChange }: { value: bigint; onChange: (value: bigint) => void }) {
  return (
    <fieldset className="fi-slippage-control">
      <legend>Max slippage</legend>
      <div className="fi-slippage-options" role="group" aria-label="Maximum slippage">
        {[50n, 100n, 200n].map((bps) => (
          <button type="button" className={value === bps ? "active" : ""} aria-pressed={value === bps} onClick={() => onChange(bps)} key={bps.toString()}>
            {Number(bps) / 100}%
          </button>
        ))}
      </div>
    </fieldset>
  );
}
