import { type ReactNode, useMemo } from "react";
import { identiconDataUrl } from "../../core/lib/identicon";

/**
 * The address picture. Decorative: the address text next to it is what
 * is read out, so the image is hidden from screen readers. Nothing for an
 * invalid address, so the caller's fallback shows.
 */
export function Identicon({ address, size = 16 }: { address: string | null | undefined; size?: number }): ReactNode {
  const src = useMemo(() => (address ? identiconDataUrl(address) : ""), [address]);
  if (!src) return null;
  return (
    <img
      className="w-identicon"
      src={src}
      width={size}
      height={size}
      alt=""
      aria-hidden="true"
      draggable={false}
    />
  );
}
