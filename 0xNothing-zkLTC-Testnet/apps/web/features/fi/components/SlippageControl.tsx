"use client";

export function SlippageControl({ value, onChange }: { value: bigint; onChange: (value: bigint) => void }) {
  return (
    <fieldset className="fi-slippage-control">
      <legend>Max slippage</legend>
      <div className="fi-slippage-options">
        {[50n, 100n, 200n].map((bps) => (
          <button type="button" className={value === bps ? "active" : ""} onClick={() => onChange(bps)} key={bps.toString()}>
            {Number(bps) / 100}%
          </button>
        ))}
      </div>
    </fieldset>
  );
}

