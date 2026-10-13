"use client";

import { useState } from "react";
import { cx } from "./cx";

/** FNV-1a over the lowercase address; deterministic and dependency free. */
function hash(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** 5×5 mirrored identicon cells for an address. Exported for tests/reuse. */
export function identiconCells(seed: string): { cells: boolean[]; hue: number } {
  const h = hash(seed.toLowerCase());
  const cells: boolean[] = [];
  for (let row = 0; row < 5; row++) {
    for (let col = 0; col < 5; col++) {
      const source = col < 3 ? col : 4 - col;
      cells.push(((h >>> ((row * 3 + source) % 30)) & 1) === 1);
    }
  }
  return { cells, hue: h % 360 };
}

export function PixelIdenticon({ seed, size = 32, className }: { seed: string; size?: number; className?: string }) {
  const { cells, hue } = identiconCells(seed);
  return (
    <svg
      aria-hidden="true"
      width={size}
      height={size}
      viewBox="0 0 5 5"
      shapeRendering="crispEdges"
      className={cx("rounded-full bg-surface-3", className)}
    >
      {cells.map((on, index) => on ? (
        <rect key={index} x={index % 5} y={Math.floor(index / 5)} width={1} height={1} fill={`hsl(${hue} 55% 62%)`} />
      ) : null)}
    </svg>
  );
}

/** Token logo with a deterministic pixel identicon fallback (never an empty circle). */
export function TokenLogo({ src, address, symbol, size = 32, className }: {
  src?: string | null; address: string; symbol?: string; size?: number; className?: string;
}) {
  const [failed, setFailed] = useState(false);
  if (!src || failed) return <PixelIdenticon seed={address} size={size} className={className} />;
  return (
    // eslint-disable-next-line @next/next/no-img-element -- remote IPFS logos, sized by caller
    <img
      src={src}
      alt={symbol ? `${symbol} logo` : ""}
      width={size}
      height={size}
      loading="lazy"
      onError={() => setFailed(true)}
      className={cx("rounded-full object-cover bg-surface-3", className)}
      style={{ width: size, height: size }}
    />
  );
}
