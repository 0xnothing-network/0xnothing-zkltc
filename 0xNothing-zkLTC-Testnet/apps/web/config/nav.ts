/** Product switcher + per-product sub-nav for the unified AppShell (spec §5, §7). */

export type ProductId = "hub" | "pump" | "fi" | "pixel";

export interface NavItem {
  href: string;
  label: string;
  /** Extra path prefixes that should mark this item active. */
  match?: ReadonlyArray<string>;
  /** Exact match only (for product roots). */
  exact?: boolean;
}

export interface ProductNav {
  id: Exclude<ProductId, "hub">;
  name: string;
  suffix: string;
  href: string;
  blurb: string;
  items: ReadonlyArray<NavItem>;
}

export const PRODUCTS: ReadonlyArray<ProductNav> = [
  {
    id: "pump",
    name: "0xPump",
    suffix: "Pump",
    href: "/0xPump",
    blurb: "Launchpad and NUSD",
    items: [
      { href: "/0xPump", label: "Discover", exact: true, match: ["/0xPump/token/"] },
      { href: "/0xPump/create", label: "Create" },
      { href: "/0xPump/nusd", label: "NUSD" },
      { href: "/0xPump/portfolio", label: "Portfolio" },
      { href: "/0xPump/stats", label: "Stats" },
    ],
  },
  {
    id: "fi",
    name: "0xFi",
    suffix: "Fi",
    href: "/0xFi",
    blurb: "Swap, pools, lend, synth",
    items: [
      { href: "/0xFi/swap", label: "Swap", match: ["/0xFi"], exact: true },
      { href: "/0xFi/pools", label: "Pools" },
      { href: "/0xFi/earn", label: "Earn", match: ["/0xFi/farm"] },
      { href: "/0xFi/lend", label: "Lend & Borrow", match: ["/0xFi/borrow"] },
      { href: "/0xFi/synth", label: "Synth" },
      { href: "/0xFi/rwa", label: "RWA" },
    ],
  },
  {
    id: "pixel",
    name: "0xPixel",
    suffix: "Pixel",
    href: "/0xpixel",
    blurb: "Draw and trade on-chain art",
    items: [
      { href: "/0xpixel", label: "Draw", exact: true },
      { href: "/0xpixel/gallery", label: "Gallery" },
      { href: "/0xpixel/marketplace", label: "Marketplace" },
    ],
  },
];

export function productById(id: ProductNav["id"]): ProductNav {
  const product = PRODUCTS.find((candidate) => candidate.id === id);
  if (!product) throw new Error(`Unknown product ${id}`);
  return product;
}

function matchesPath(pathname: string, target: string, exact: boolean): boolean {
  if (exact) return pathname === target;
  return pathname === target || pathname.startsWith(target.endsWith("/") ? target : `${target}/`);
}

/** Whether a nav item is the current page. Pure for tests. */
export function isNavItemActive(pathname: string | null | undefined, item: NavItem): boolean {
  if (!pathname) return false;
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  if (matchesPath(path, item.href, Boolean(item.exact))) return true;
  return (item.match ?? []).some((prefix) =>
    prefix.endsWith("/") ? path.startsWith(prefix) : path === prefix);
}
