"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  ArrowsLeftRight,
  ChartLineUp,
  Coins,
  HandCoins,
  PiggyBank,
  Vault,
} from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { useAccount, useSwitchChain } from "wagmi";
import { deployment } from "@fi/config/deployment";
import { FI_BASE_PATH, fiPath } from "@fi/config/paths";
import { useToast } from "@fi/components/Toast";
import { ProductHeader, type HeaderNotice } from "@/components/ProductHeader";

const NAV_ITEMS = [
  { href: "/", label: "Swap", icon: ArrowsLeftRight },
  { href: "/pools", label: "Pools", icon: Coins },
  { href: "/earn", label: "Farm", icon: ChartLineUp },
  { href: "/lend", label: "Lend", icon: PiggyBank },
  { href: "/borrow", label: "Borrow", icon: HandCoins },
  { href: "/synth", label: "Synth", icon: Vault },
  { href: "/rwa", label: "RWA", icon: Coins },
] as const;

function activePath(pathname: string, href: string): boolean {
  const localPath = pathname === FI_BASE_PATH
    ? "/"
    : pathname.startsWith(`${FI_BASE_PATH}/`) ? pathname.slice(FI_BASE_PATH.length) : pathname;
  if (href === "/") return localPath === "/" || localPath === "/swap";
  if (href === "/pools") return localPath === "/pools" || localPath.startsWith("/pools/");
  return localPath === href || localPath.startsWith(`${href}/`);
}

export function FiHeader() {
  const pathname = usePathname();
  const toast = useToast();
  const [mounted, setMounted] = useState(false);
  const { chainId, isConnected } = useAccount();
  const { switchChain } = useSwitchChain();
  const wrongChain = Boolean(isConnected && chainId !== deployment.chain.id);

  useEffect(() => setMounted(true), []);

  const notify: HeaderNotice = (kind, title, message) => toast.show(title, message ?? "", kind);
  const nav = NAV_ITEMS.map((item) => {
    const Icon = item.icon;
    return { href: fiPath(item.href), label: item.label, icon: <Icon size={16} aria-hidden="true" /> };
  });
  const localHref = new Map(NAV_ITEMS.map((item) => [fiPath(item.href), item.href]));

  return (
    <>
      <ProductHeader product="fi" nav={nav} isActive={(href) => activePath(pathname, localHref.get(href) ?? href)} notify={notify} />
      {mounted && wrongChain ? (
        <div className="fi-network-guard" role="alert">
          Wallet is connected to chain {chainId}. Transactions require LitVM chain {deployment.chain.id}.
          <button type="button" onClick={() => switchChain({ chainId: deployment.chain.id })}>Switch now</button>
        </div>
      ) : null}
      <nav className="fi-mobile-dock" aria-label="Primary mobile navigation">
        {NAV_ITEMS.map((item) => {
          const active = activePath(pathname, item.href);
          const Icon = item.icon;
          return (
            <Link
              href={fiPath(item.href)}
              key={item.href}
              className={active ? "active" : undefined}
              aria-current={active ? "page" : undefined}
              aria-label={item.label}
            >
              <Icon size={20} weight="regular" aria-hidden="true" />
              <span>{item.label}</span>
            </Link>
          );
        })}
      </nav>
    </>
  );
}
