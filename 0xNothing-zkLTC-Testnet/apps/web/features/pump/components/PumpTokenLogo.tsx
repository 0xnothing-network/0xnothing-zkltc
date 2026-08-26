"use client";

import { memo, useMemo, useState } from "react";
import { getPumpImageUrl } from "@/features/pump/config";

interface PumpTokenLogoProps {
  imageUri: string;
  name: string;
  symbol: string;
  size: number;
  priority?: boolean;
  decorative?: boolean;
}

function PumpTokenLogoInner({
  imageUri,
  name,
  symbol,
  size,
  priority = false,
  decorative = false,
}: PumpTokenLogoProps) {
  const source = useMemo(() => getPumpImageUrl(imageUri, symbol), [imageUri, symbol]);
  const [failedSource, setFailedSource] = useState("");
  const [trackedSource, setTrackedSource] = useState(source);
  const initials = useMemo(
    () => symbol.trim().replace(/[^a-zA-Z0-9]/g, "").slice(0, 2).toUpperCase() || "?",
    [symbol],
  );
  const alt = decorative ? "" : `${name} logo`;

  // Drop a stale failure during render instead of in an effect: a new source has
  // to paint as an image on its first commit, never as the previous fallback.
  if (source !== trackedSource) {
    setTrackedSource(source);
    if (failedSource) setFailedSource("");
  }

  const failed = !source || failedSource === source;

  if (failed) {
    return (
      <span
        aria-hidden={decorative || undefined}
        aria-label={decorative ? undefined : alt}
        role={decorative ? undefined : "img"}
      >
        {initials}
      </span>
    );
  }

  const handleError = () => setFailedSource(source);

  return (
    // Both sources stay plain <img>. The same-origin IPFS proxy must skip Next's
    // image optimizer, which can run on a separate host in production and turn a
    // healthy proxy response into a misleading /_next/image 404; legacy HTTPS
    // logos stay browser-fetched so the server never proxies an arbitrary host.
    // eslint-disable-next-line @next/next/no-img-element
    <img
      key={source}
      src={source}
      alt={alt}
      width={size}
      height={size}
      loading={priority ? "eager" : "lazy"}
      decoding="async"
      fetchPriority={priority ? "high" : "auto"}
      referrerPolicy="no-referrer"
      onError={handleError}
    />
  );
}

export const PumpTokenLogo = memo(PumpTokenLogoInner);
