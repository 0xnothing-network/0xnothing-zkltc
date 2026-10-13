import type { AnchorHTMLAttributes, ReactNode } from "react";
import {
  FIRST_PARTY_EXTERNAL_REL,
  USER_EXTERNAL_REL,
  normalizeExternalHref,
} from "@/lib/safeExternalHref";

type ExternalLinkProps = Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href" | "rel" | "target"> & {
  href: string;
  children: ReactNode;
  userGenerated?: boolean;
};

/**
 * Opens a pre-checked https URL in a new tab with a tab-nabbing-safe rel.
 * User-generated hrefs are normalized again at render time; invalid values
 * render nothing instead of an unsafe anchor.
 */
export function ExternalLink({
  href,
  children,
  userGenerated = false,
  className,
  ...props
}: ExternalLinkProps) {
  const safeHref = userGenerated ? normalizeExternalHref(href) : href;
  if (!safeHref) return null;
  return (
    <a
      {...props}
      href={safeHref}
      target="_blank"
      rel={userGenerated ? USER_EXTERNAL_REL : FIRST_PARTY_EXTERNAL_REL}
      className={className}
    >
      {children}
    </a>
  );
}
