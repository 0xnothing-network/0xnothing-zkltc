"use client";

import Image from "next/image";
import { useEffect, useMemo, useState } from "react";
import { getPumpImageUrl } from "@/features/pump/config";

const LOGO_PLACEHOLDER =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 16 16'%3E%3Cpath fill='%2315191c' d='M0 0h16v16H0z'/%3E%3Cpath fill='%23242b2f' d='M0 0h8v8H0zm8 8h8v8H8z'/%3E%3C/svg%3E";

interface PumpTokenLogoProps {
  imageUri: string;
  name: string;
  symbol: string;
  size: number;
  sizes: string;
  priority?: boolean;
  decorative?: boolean;
}

export function PumpTokenLogo({
  imageUri,
  name,
  symbol,
  size,
  sizes,
  priority = false,
  decorative = false,
}: PumpTokenLogoProps) {
  const source = useMemo(() => getPumpImageUrl(imageUri), [imageUri]);
  const [failedSource, setFailedSource] = useState("");
  const failed = !source || failedSource === source;
  const initials = symbol.trim().replace(/[^a-zA-Z0-9]/g, "").slice(0, 2).toUpperCase() || "?";
  const alt = decorative ? "" : `${name} logo`;

  useEffect(() => {
    if (failedSource && failedSource !== source) setFailedSource("");
  }, [failedSource, source]);

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
  if (source.startsWith("/api/pump/image?")) {
    return (
      <Image
        key={source}
        src={source}
        alt={alt}
        width={size}
        height={size}
        sizes={sizes}
        priority={priority}
        fetchPriority={priority ? "high" : "auto"}
        loading={priority ? "eager" : "lazy"}
        placeholder="blur"
        blurDataURL={LOGO_PLACEHOLDER}
        onError={handleError}
      />
    );
  }

  return (
    // Legacy HTTPS logos stay browser-fetched so the server never proxies an arbitrary host.
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
