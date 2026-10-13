"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { getPixelImageUrl } from "@/lib/pixelImage";

type Minted = { id: string; collection: string; tokenId: string };

/** The latest artworks minted on 0xPixel — real work instead of decoration. */
export function HomeMosaic() {
  const [tiles, setTiles] = useState<Minted[] | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/marketplace/activity?type=MINTED&limit=9", { signal: controller.signal })
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error(String(response.status)))))
      .then((page: { events?: Minted[] }) => setTiles((page.events ?? []).slice(0, 9)))
      .catch(() => { if (!controller.signal.aborted) setTiles([]); });
    return () => controller.abort();
  }, []);

  if (tiles && tiles.length === 0) return null;
  const shown = tiles ?? Array.from({ length: 9 }, (_, index) => ({ id: `skeleton-${index}`, collection: "", tokenId: "" }));
  return (
    <figure className="nothing-mosaic" aria-busy={!tiles}>
      <figcaption>Fresh from 0xPixel</figcaption>
      <div className="nothing-mosaic-grid">
        {shown.map((tile) => (
          tile.tokenId ? (
            <Link key={tile.id} href="/0xpixel/marketplace" className="nothing-mosaic-tile" aria-label={`0xPixel #${tile.tokenId}`}>
              {/* eslint-disable-next-line @next/next/no-img-element -- pixel art is served pre-sized and must stay unoptimised */}
              <img src={getPixelImageUrl(tile.tokenId, tile.collection)} alt="" width={96} height={96} loading="lazy" />
              <span>#{tile.tokenId}</span>
            </Link>
          ) : <span key={tile.id} className="nothing-mosaic-tile" data-skeleton="" />
        ))}
      </div>
    </figure>
  );
}
