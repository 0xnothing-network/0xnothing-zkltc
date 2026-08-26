"use client";

import { memo, useMemo, useState } from "react";
import { tokenImageUrl } from "@fi/lib/tokenImage";

export { tokenImageUrl } from "@fi/lib/tokenImage";

type TokenLogoSize = "sm" | "md" | "lg";

// Hoisted so a pool list does not rebuild these lookups for every logo it paints.
const CORE_MARKS: Record<string, string> = {
  NUSD: "$",
  ZKLTC: "L",
  WZKLTC: "L",
  NBTC: "B",
  NETH: "E",
};

const CORE_IMAGES: Record<string, string> = {
  NUSD: "/NUSD_LOGO.jpg",
  NETH: "/eth-logo.webp",
  NBTC: "/btc-logo.png",
  ZKLTC: "/ltc-logo.png",
  WZKLTC: "/ltc-logo.png",
};

function fallbackLabel(symbol: string): string {
  const clean = symbol.replace(/[^a-z0-9]/gi, "").toUpperCase();
  if (CORE_MARKS[clean]) return CORE_MARKS[clean];
  return clean.slice(0, clean.length > 3 ? 2 : 1) || "?";
}

function logoTone(symbol: string): string {
  const normalized = symbol.toLowerCase();
  if (normalized.includes("nusd")) return "nusd";
  if (normalized.includes("ltc")) return "ltc";
  if (normalized.includes("btc")) return "btc";
  if (normalized.includes("eth")) return "eth";
  return "pump";
}

function coreTokenImage(symbol: string): string | undefined {
  return CORE_IMAGES[symbol.replace(/[^a-z0-9]/gi, "").toUpperCase()];
}

function TokenLogoInner({
  symbol,
  imageUrl,
  size = "md",
  trustedCore = true,
}: {
  symbol: string;
  imageUrl?: string;
  size?: TokenLogoSize;
  trustedCore?: boolean;
}) {
  // tokenImageUrl parses a URL, so keep it off the block-sync re-render path.
  const normalizedImage = useMemo(
    () => tokenImageUrl(imageUrl, symbol) ?? (trustedCore ? coreTokenImage(symbol) : undefined),
    [imageUrl, symbol, trustedCore],
  );
  const [failedSource, setFailedSource] = useState("");
  const [trackedSource, setTrackedSource] = useState(normalizedImage);

  // Clear a stale failure during render so a new source paints as an image on its
  // first commit instead of flashing the letter fallback for one frame.
  if (normalizedImage !== trackedSource) {
    setTrackedSource(normalizedImage);
    if (failedSource) setFailedSource("");
  }

  const failed = Boolean(normalizedImage && failedSource === normalizedImage);

  return (
    <span className="fi-token-logo" data-size={size} data-tone={trustedCore ? logoTone(symbol) : "pump"}>
      {normalizedImage && !failed ? (
        // User-provided immutable images are served through the same-origin proxy.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          key={normalizedImage}
          src={normalizedImage}
          alt={`${symbol} token logo`}
          decoding="async"
          loading="lazy"
          referrerPolicy="no-referrer"
          onError={() => setFailedSource(normalizedImage)}
        />
      ) : (
        <span aria-hidden="true">{fallbackLabel(symbol)}</span>
      )}
    </span>
  );
}

export const TokenLogo = memo(TokenLogoInner);

export function TokenPairLogos({
  token0,
  token1,
  size = "md",
}: {
  token0: { symbol: string; imageUrl?: string };
  token1: { symbol: string; imageUrl?: string };
  size?: TokenLogoSize;
}) {
  return (
    <span className="fi-token-pair-logos" aria-label={`${token0.symbol} and ${token1.symbol}`}>
      <TokenLogo symbol={token0.symbol} imageUrl={token0.imageUrl} size={size} />
      <TokenLogo symbol={token1.symbol} imageUrl={token1.imageUrl} size={size} />
    </span>
  );
}
