"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { formatUnits } from "viem";
import {
  useAccount,
  useBalance,
  useConnect,
  useDisconnect,
  useReadContract,
  useSwitchChain,
} from "wagmi";
import { nusdAbi } from "@/features/pump/abis";
import {
  NUSD_CONFIGURED,
  PUMP_CHAIN_ID,
  PUMP_NUSD_ADDRESS,
} from "@/features/pump/config";
import { formatWad, shortAddress } from "@/features/pump/format";
import { useToast } from "@/components/Toast";

const PUMP_NAV = [
  { href: "/0xPump", label: "Discover" },
  { href: "/0xPump/create", label: "Create" },
  { href: "/0xPump/nusd", label: "NUSD" },
  { href: "/0xPump/portfolio", label: "Portfolio" },
  { href: "/0xPump/faq", label: "FAQ" },
] as const;

function isActiveRoute(pathname: string, href: (typeof PUMP_NAV)[number]["href"]): boolean {
  if (href === "/0xPump") {
    return pathname === href || pathname.startsWith("/0xPump/token/");
  }
  return pathname === href || pathname.startsWith(`${href}/`);
}

function displayBalance(value: bigint | undefined, pending: boolean): string {
  if (value !== undefined) return formatWad(value, 4);
  return pending ? "..." : "--";
}

function displayUsdBalance(value: bigint | undefined, pending: boolean): string {
  const amount = displayBalance(value, pending);
  return amount === "..." || amount === "--" ? amount : `$${amount}`;
}

export function PumpHeader() {
  const pathname = usePathname();
  const toast = useToast();
  const [mobileOpen, setMobileOpen] = useState(false);
  const { address, isConnected, chainId } = useAccount();
  const { connectors, connect, isPending } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChain, isPending: isSwitching } = useSwitchChain();
  const wrongChain = isConnected && chainId !== PUMP_CHAIN_ID;
  const balanceEnabled = Boolean(isConnected && address && !wrongChain);
  const nativeBalance = useBalance({
    address,
    chainId: PUMP_CHAIN_ID,
    query: {
      enabled: balanceEnabled,
      refetchInterval: 15_000,
    },
  });
  const nusdBalance = useReadContract({
    address: PUMP_NUSD_ADDRESS,
    abi: nusdAbi,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    chainId: PUMP_CHAIN_ID,
    query: {
      enabled: balanceEnabled && NUSD_CONFIGURED,
      refetchInterval: 15_000,
    },
  });

  const connectWallet = () => {
    const connector = connectors[0];
    if (!connector) {
      toast.warning("No wallet detected", "Install a browser wallet and refresh the page.");
      return;
    }
    connect({ connector });
  };

  return (
    <header className="pump-header">
      <div className="pump-header-inner">
        <Link href="/" className="pump-wordmark" aria-label="0xNothing home">
          <span className="pump-wordmark-zero">0x</span>
          <span>PUMP</span>
        </Link>

        <nav className="pump-nav pump-nav-desktop" aria-label="0xPump navigation">
          {PUMP_NAV.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className={isActiveRoute(pathname, item.href) ? "pump-nav-link active" : "pump-nav-link"}
              aria-current={isActiveRoute(pathname, item.href) ? "page" : undefined}
            >
              {item.label}
            </Link>
          ))}
        </nav>

        {isConnected && address && !wrongChain ? (
          <div
            className="pump-header-balances"
            aria-label="Wallet balances on LitVM LiteForge"
            aria-live="polite"
            aria-busy={nativeBalance.isPending || (NUSD_CONFIGURED && nusdBalance.isPending)}
          >
            <div
              className="pump-header-balance"
              title={nusdBalance.data !== undefined ? `$${formatUnits(nusdBalance.data, 18)} NUSD balance` : "NUSD balance"}
            >
              <span>NUSD</span>
              <strong>{displayUsdBalance(nusdBalance.data, NUSD_CONFIGURED && nusdBalance.isPending)}</strong>
            </div>
            <div
              className="pump-header-balance"
              title={nativeBalance.data ? `${nativeBalance.data.formatted} zkLTC` : "zkLTC balance"}
            >
              <span>zkLTC</span>
              <strong>{displayBalance(nativeBalance.data?.value, nativeBalance.isPending)}</strong>
            </div>
          </div>
        ) : null}

        <div className="pump-wallet-actions">
          {wrongChain ? (
            <button
              className="pump-button pump-button-warning"
              type="button"
              disabled={isSwitching}
              onClick={() => switchChain({ chainId: PUMP_CHAIN_ID })}
            >
              {isSwitching ? "Switching" : "Switch network"}
            </button>
          ) : isConnected && address ? (
            <button
              className="pump-button pump-button-muted"
              type="button"
              title="Disconnect wallet"
              onClick={() => disconnect()}
            >
              {shortAddress(address)}
            </button>
          ) : (
            <button
              className="pump-button pump-button-primary"
              type="button"
              disabled={isPending}
              onClick={connectWallet}
            >
              {isPending ? "Connecting" : "Connect"}
            </button>
          )}
          <button
            type="button"
            className="pump-menu-button"
            aria-label={mobileOpen ? "Close navigation" : "Open navigation"}
            aria-expanded={mobileOpen}
            aria-controls="pump-mobile-navigation"
            onClick={() => setMobileOpen((open) => !open)}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M4 7h16M4 12h16M4 17h16" />
            </svg>
          </button>
        </div>
      </div>

      {mobileOpen ? (
        <nav id="pump-mobile-navigation" className="pump-nav-mobile" aria-label="Mobile 0xPump navigation">
          {PUMP_NAV.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className={isActiveRoute(pathname, item.href) ? "pump-nav-link active" : "pump-nav-link"}
              aria-current={isActiveRoute(pathname, item.href) ? "page" : undefined}
              onClick={() => setMobileOpen(false)}
            >
              {item.label}
            </Link>
          ))}
        </nav>
      ) : null}
    </header>
  );
}
