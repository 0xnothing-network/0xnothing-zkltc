import { type ReactNode, useEffect, useState } from "react";
import { FALLBACK_TOKEN_LOGO, type WalletToken } from "../../config/assets";
import { pumpTokenImageUrl } from "../../core/lib/pumpImage";

/**
 * Token mark. Built-ins ship their own image in public/tokens; an imported token
 * has none, so it falls back to the brand mark and then to its own initials —
 * a broken image icon is never shown.
 */
type Stage = "logo" | "brand" | "initials";

export function TokenLogo({ token, size }: { token: WalletToken; size?: number }): ReactNode {
  const imageUrl = pumpTokenImageUrl(token.logo, token.symbol);
  const [stage, setStage] = useState<Stage>(imageUrl ? "logo" : "brand");

  useEffect(() => {
    setStage(imageUrl ? "logo" : "brand");
  }, [imageUrl, token.id]);

  // Keep sizing in the stylesheet so the extension's CSP and design-token
  // contract stay consistent. Unknown sizes intentionally use the base mark.
  const sizeToken = size === undefined ? undefined : size >= 48 ? "lg" : size >= 32 ? "md" : "sm";

  if (stage === "initials") {
    return (
      <span className="w-logo" data-fallback="true" data-size={sizeToken} aria-hidden="true">
        {token.symbol.slice(0, 3).toUpperCase()}
      </span>
    );
  }

  return (
    <img
      className="w-logo"
      data-size={sizeToken}
      src={stage === "logo" && imageUrl ? imageUrl : FALLBACK_TOKEN_LOGO}
      alt=""
      decoding="async"
      loading="lazy"
      referrerPolicy="no-referrer"
      onError={() => setStage(stage === "logo" ? "brand" : "initials")}
    />
  );
}
