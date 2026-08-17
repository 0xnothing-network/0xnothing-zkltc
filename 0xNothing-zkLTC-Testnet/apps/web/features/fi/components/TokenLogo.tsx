"use client";

import { useEffect, useState } from "react";
import { tokenImageUrl } from "@fi/lib/tokenImage";

export { tokenImageUrl } from "@fi/lib/tokenImage";

type TokenLogoSize = "sm" | "md" | "lg";

function fallbackLabel(symbol: string): string {
  const clean = symbol.replace(/[^a-z0-9]/gi, "").toUpperCase();
  const coreMark: Record<string, string> = {
    NUSD: "$",
    ZKLTC: "L",
    WZKLTC: "L",
    NBTC: "B",
    NETH: "E",
  };
  if (coreMark[clean]) return coreMark[clean];
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
  const coreImages: Record<string, string> = {
    NUSD: "/NUSD_LOGO.jpg",
    NETH: "/eth-logo.webp",
    NBTC: "/btc-logo.png",
    ZKLTC: "/ltc-logo.png",
    WZKLTC: "/ltc-logo.png",
  };
  return coreImages[symbol.replace(/[^a-z0-9]/gi, "").toUpperCase()];
}

export function TokenLogo({
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
  const normalizedImage = tokenImageUrl(imageUrl) ?? (trustedCore ? coreTokenImage(symbol) : undefined);
  const [failedSource, setFailedSource] = useState("");
  const failed = Boolean(normalizedImage && failedSource === normalizedImage);

  useEffect(() => {
    if (failedSource && failedSource !== normalizedImage) setFailedSource("");
  }, [failedSource, normalizedImage]);

  return (
    <span className="fi-token-logo" data-size={size} data-tone={trustedCore ? logoTone(symbol) : "pump"}>
      {normalizedImage && !failed ? (
        // Token images are user-provided immutable metadata served only by allow-listed gateways.
        // eslint-disable-next-line @next/next/no-img-element
        <img
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
