"use client";

import Link from "next/link";
import { PRODUCTS, type ProductId } from "@/config/nav";
import { cx } from "@/components/ui/cx";
import { usePopover } from "./usePopover";

const dotColor: Record<Exclude<ProductId, "hub">, string> = {
  pump: "bg-[var(--lime-400)]",
  fi: "bg-[var(--lite-400)]",
  pixel: "bg-[var(--prism-400)]",
};

/** Product-switcher pill: jump between 0xPump, 0xFi and 0xPixel without the Hub. */
export function ProductSwitcher({ current }: { current: ProductId }) {
  const { open, toggle, close, triggerRef, panelRef } = usePopover();
  const active = PRODUCTS.find((product) => product.id === current);
  return (
    <div className="relative">
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="true"
        aria-expanded={open}
        onClick={toggle}
        className="inline-flex h-9 items-center gap-2 rounded-full border border-line bg-surface-2 px-3 font-ui text-[13px] font-medium text-fg hover:border-line-strong focus-ring"
      >
        {active ? <span aria-hidden="true" className={cx("size-2 rounded-full", dotColor[active.id])} /> : null}
        {active?.name ?? "Products"}
        <span aria-hidden="true" className="text-fg-3">▾</span>
        <span className="sr-only">, switch product</span>
      </button>
      {open ? (
        <div ref={panelRef} className="absolute left-0 top-[calc(100%+8px)] z-[80] w-64 rounded-ui-lg border border-line-strong bg-surface-1 p-1.5 shadow-e2">
          <ul className="grid">
            {PRODUCTS.map((product) => (
              <li key={product.id}>
                <Link
                  href={product.href}
                  onClick={() => close()}
                  aria-current={product.id === current ? "page" : undefined}
                  className={cx(
                    "flex items-center gap-3 rounded-ui-sm px-2.5 py-2 hover:bg-surface-3 focus-ring",
                    product.id === current && "bg-surface-3",
                  )}
                >
                  <span aria-hidden="true" className={cx("size-2 rounded-full", dotColor[product.id])} />
                  <span className="grid">
                    <span className="font-ui text-sm font-medium text-fg">{product.name}</span>
                    <span className="font-ui text-xs text-fg-3">{product.blurb}</span>
                  </span>
                </Link>
              </li>
            ))}
            <li className="mt-1 border-t border-line pt-1">
              <Link href="/" onClick={() => close()} className="flex rounded-ui-sm px-2.5 py-2 font-ui text-sm text-fg-2 hover:bg-surface-3 hover:text-fg focus-ring">
                0xNothing home
              </Link>
            </li>
          </ul>
        </div>
      ) : null}
    </div>
  );
}
