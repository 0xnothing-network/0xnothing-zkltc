"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { isNavItemActive, PRODUCTS, productById, type ProductNav } from "@/config/nav";
import { Modal } from "@/components/ui/Modal";
import { cx } from "@/components/ui/cx";
import { NetworkPill } from "./NetworkPill";
import { ProductSwitcher } from "./ProductSwitcher";
import { WalletMenu } from "./WalletMenu";
import { WalletModalProvider } from "./WalletModalProvider";
import { WrongNetworkBanner } from "./WrongNetworkBanner";

function SubNav({ product, pathname }: { product: ProductNav; pathname: string }) {
  return (
    <nav aria-label={`${product.name} navigation`} className="max-lg:hidden">
      <ul className="flex items-center gap-1">
        {product.items.map((item) => {
          const active = isNavItemActive(pathname, item);
          return (
            <li key={item.href}>
              <Link
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={cx(
                  "relative inline-flex h-16 items-center px-3 font-ui text-sm font-medium transition-colors duration-[120ms] focus-ring",
                  active ? "text-fg" : "text-fg-3 hover:text-fg-2",
                )}
              >
                {item.label}
                {active ? <span aria-hidden="true" className="absolute inset-x-3 bottom-0 h-0.5 rounded-full bg-accent" /> : null}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

const tabClass = (active: boolean) => cx(
  "relative flex h-full w-full items-center justify-center truncate px-1 font-ui text-xs font-medium focus-ring",
  active ? "text-accent-text" : "text-fg-3",
);

function BottomTabs({ product, pathname }: { product: ProductNav; pathname: string }) {
  const [menuOpen, setMenuOpen] = useState(false);
  useEffect(() => setMenuOpen(false), [pathname]);
  // Four section tabs + "Menu" (all sections, product switcher) keeps 5 targets at 390px.
  const items = product.items.slice(0, 4);
  return (
    <>
      <nav
        aria-label={`${product.name} sections`}
        className="ui fixed inset-x-0 bottom-0 z-[60] border-t border-line bg-bg/95 backdrop-blur lg:hidden"
        style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
      >
        <ul className="grid h-16" style={{ gridTemplateColumns: `repeat(${items.length + 1}, minmax(0, 1fr))` }}>
          {items.map((item) => {
            const active = isNavItemActive(pathname, item);
            return (
              <li key={item.href} className="min-w-0">
                <Link href={item.href} aria-current={active ? "page" : undefined} className={tabClass(active)}>
                  {active ? <span aria-hidden="true" className="absolute inset-x-4 top-0 h-0.5 rounded-full bg-accent" /> : null}
                  {item.label}
                </Link>
              </li>
            );
          })}
          <li className="min-w-0">
            <button type="button" aria-haspopup="dialog" onClick={() => setMenuOpen(true)} className={tabClass(false)}>
              Menu
            </button>
          </li>
        </ul>
      </nav>
      <Modal open={menuOpen} onClose={() => setMenuOpen(false)} title={product.name} variant="sheet">
        <ul className="grid gap-1">
          {product.items.map((item) => {
            const active = isNavItemActive(pathname, item);
            return (
              <li key={item.href}>
                <Link
                  href={item.href}
                  aria-current={active ? "page" : undefined}
                  className={cx("flex h-11 items-center rounded-ui-sm px-3 font-ui text-sm hover:bg-surface-3 focus-ring", active ? "bg-surface-3 text-fg" : "text-fg-2")}
                >
                  {item.label}
                </Link>
              </li>
            );
          })}
        </ul>
        <p className="eyebrow mt-5 mb-2 px-1">Products</p>
        <ul className="grid gap-1">
          {PRODUCTS.map((candidate) => (
            <li key={candidate.id}>
              <Link
                href={candidate.href}
                aria-current={candidate.id === product.id ? "true" : undefined}
                className="flex h-11 items-center justify-between rounded-ui-sm px-3 font-ui text-sm text-fg-2 hover:bg-surface-3 hover:text-fg focus-ring"
              >
                {candidate.name}
                <span className="text-xs text-fg-3">{candidate.blurb}</span>
              </Link>
            </li>
          ))}
          <li>
            <Link href="/" className="flex h-11 items-center rounded-ui-sm px-3 font-ui text-sm text-fg-2 hover:bg-surface-3 hover:text-fg focus-ring">0xNothing home</Link>
          </li>
        </ul>
      </Modal>
    </>
  );
}

/**
 * Unified shell for Pump, Fi and Pixel (spec §0.1, §10 Phase 2): wordmark with
 * product suffix, product switcher, sub-nav, network pill, wallet menu,
 * wrong-network banner and a mobile bottom tab bar.
 */
export function AppShell({ product: productId, children }: { product: ProductNav["id"]; children: ReactNode }) {
  const pathname = usePathname() ?? "";
  const product = productById(productId);
  return (
    <WalletModalProvider>
      <header className="ui sticky top-0 z-[70] border-b border-line bg-bg/90 backdrop-blur font-ui">
        <div className="mx-auto flex h-16 max-w-[1280px] items-center gap-3 px-4 max-sm:h-14 sm:px-6">
          <Link href="/" className="font-brand text-lg tracking-tight text-fg focus-ring" aria-label={`0xNothing home (${product.name})`}>
            0x<span className="text-accent-text">{product.suffix}</span>
          </Link>
          <div className="max-sm:hidden">
            <ProductSwitcher current={product.id} />
          </div>
          <SubNav product={product} pathname={pathname} />
          <div className="ml-auto flex items-center gap-2">
            <NetworkPill />
            <WalletMenu />
          </div>
        </div>
      </header>
      <WrongNetworkBanner />
      <div className="max-lg:pb-[calc(64px+env(safe-area-inset-bottom))]">{children}</div>
      <BottomTabs product={product} pathname={pathname} />
    </WalletModalProvider>
  );
}
