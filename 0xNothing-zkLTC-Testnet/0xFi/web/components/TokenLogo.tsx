"use client";

import { useEffect, useState } from "react";
import { fiPath } from "@/config/paths";

export type TokenLogoSize = "sm" | "md" | "lg";

export function tokenImageUrl(uri: string | undefined): string | undefined {
  const value = uri?.trim();
  if (!value) return undefined;
  if (value.startsWith("ipfs://")) {
    const path = value.slice("ipfs://".length).replace(/^ipfs\//, "").replace(/^\/+/, "");
    return path ? `https://dweb.link/ipfs/${path}` : undefined;
  }
  return /^https?:\/\//i.test(value) ? value : undefined;
}

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
  return symbol.replace(/[^a-z0-9]/gi, "").toUpperCase() === "NUSD"
    ? fiPath("/NUSD_LOGO.jpg")
    : undefined;
}

export function TokenLogo({
  symbol,
  imageUrl,
  size = "md",
}: {
  symbol: string;
  imageUrl?: string;
  size?: TokenLogoSize;
}) {
  const normalizedImage = tokenImageUrl(imageUrl) ?? coreTokenImage(symbol);
  const [failed, setFailed] = useState(false);

  useEffect(() => setFailed(false), [normalizedImage]);

  return (
    <span className="fi-token-logo" data-size={size} data-tone={logoTone(symbol)}>
      {normalizedImage && !failed ? (
        // Token images are user-provided immutable metadata and may use any IPFS gateway host.
        // eslint-disable-next-line @next/next/no-img-element
        <img src={normalizedImage} alt={`${symbol} token logo`} onError={() => setFailed(true)} />
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
