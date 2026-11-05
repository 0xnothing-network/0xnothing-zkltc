"use client";

import type { MouseEvent } from "react";

/**
 * Skips past the product header to the page's own <main>. Falls back to the
 * #main-content wrapper when a page renders no <main>.
 */
export function SkipLink() {
  const skip = (event: MouseEvent<HTMLAnchorElement>) => {
    const main = document.querySelector<HTMLElement>("main");
    if (!main) return;
    event.preventDefault();
    if (!main.hasAttribute("tabindex")) main.tabIndex = -1;
    main.focus();
    main.scrollIntoView({ block: "start" });
  };

  return <a href="#main-content" className="skip-link" onClick={skip}>Skip to content</a>;
}
