"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowSquareOut, CaretDown, Copy, List, SignOut, Wallet, X } from "@phosphor-icons/react";
import { formatUnits } from "viem";
import { useAccount, useBalance, useConnect, useDisconnect, useReadContract, useSwitchChain } from "wagmi";
import { getAddressExplorerUrl, shortenAddress } from "@/lib/contract";
import { PUMP_NUSD_ADDRESS } from "@/lib/publicConfig";
import { ThemeToggle } from "./ThemeToggle";

export type ProductId = "pump" | "fi" | "pixel";
export type ProductNavItem = { href: string; label: string; icon?: ReactNode };
export type HeaderNotice = (kind: "success" | "error" | "warning", title: string, message?: string) => void;

const CHAIN_ID = 4441;
const PRODUCTS: { id: ProductId; name: string; href: string }[] = [
  { id: "pump", name: "Pump", href: "/0xPump" },
  { id: "fi", name: "Fi", href: "/0xFi" },
  { id: "pixel", name: "Pixel", href: "/0xpixel" },
];
const balanceAbi = [{ type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "account", type: "address" }], outputs: [{ name: "", type: "uint256" }] }] as const;

function compact(value: bigint | undefined, decimals: number, digits: number): string {
  if (value === undefined) return "--";
  const amount = Number(formatUnits(value, decimals));
  return amount.toLocaleString("en-US", { maximumFractionDigits: digits, minimumFractionDigits: amount > 0 && amount < 1 ? Math.min(digits, 4) : 0 });
}

/**
 * Shared header for every product: 0x wordmark with the product tail in its
 * accent, product switcher, primary navigation (accent underline when active),
 * network pill, wallet menu with NUSD/zkLTC balances, and the theme toggle.
 * Product wrappers own product-specific behaviour and pass `notify` for toasts.
 */
export function ProductHeader({ product, nav, isActive, notify, className = "" }: {
  product: ProductId;
  nav: readonly ProductNavItem[];
  isActive: (href: string) => boolean;
  notify: HeaderNotice;
  className?: string;
}) {
  const [mounted, setMounted] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [walletOpen, setWalletOpen] = useState(false);
  const walletButton = useRef<HTMLButtonElement>(null);
  const walletMenu = useRef<HTMLDivElement>(null);
  const menuButton = useRef<HTMLButtonElement>(null);
  const { address, chainId, isConnected } = useAccount();
  const { connectors, connect, isPending: connecting } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChain, isPending: switching } = useSwitchChain();
  const wrongChain = Boolean(isConnected && chainId !== CHAIN_ID);
  const readsEnabled = Boolean(address && !wrongChain);
  const native = useBalance({ address, chainId: CHAIN_ID, query: { enabled: readsEnabled } });
  const nusd = useReadContract({
    address: PUMP_NUSD_ADDRESS, abi: balanceAbi, functionName: "balanceOf",
    args: address ? [address] : undefined, chainId: CHAIN_ID, query: { enabled: readsEnabled },
  });
  const current = PRODUCTS.find((entry) => entry.id === product)!;

  useEffect(() => setMounted(true), []);

  const closeWallet = useCallback((restoreFocus = false) => {
    setWalletOpen(false);
    if (restoreFocus) requestAnimationFrame(() => walletButton.current?.focus());
  }, []);

  useEffect(() => {
    if (!walletOpen && !menuOpen) return;
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Node;
      if (walletOpen && !walletMenu.current?.contains(target) && !walletButton.current?.contains(target)) closeWallet();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (walletOpen) closeWallet(true);
      if (menuOpen) { setMenuOpen(false); menuButton.current?.focus(); }
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [closeWallet, menuOpen, walletOpen]);

  const connectWallet = () => {
    const connector = connectors.find((candidate) => candidate.type === "injected") ?? connectors[0];
    if (!connector) {
      notify("warning", "No wallet detected", "Install or enable an EVM wallet in this browser, then try again.");
      return;
    }
    connect({ connector }, { onError: (error) => notify("error", "Could not connect wallet", error.message) });
  };

  const copyAddress = async () => {
    if (!address) return;
    try {
      await navigator.clipboard.writeText(address);
      notify("success", "Address copied", shortenAddress(address));
    } catch {
      notify("error", "Copy blocked", "The browser denied clipboard access.");
    }
    closeWallet(true);
  };

  const navLinks = (mobile: boolean) => nav.map((item) => {
    const active = isActive(item.href);
    return (
      <Link key={item.href} href={item.href} className={`ox-nav-link${active ? " active" : ""}`} aria-current={active ? "page" : undefined}
        onClick={mobile ? () => setMenuOpen(false) : undefined}>
        {mobile ? item.icon : null}{item.label}
      </Link>
    );
  });

  return (
    <header className={`ox-header ${className}`.trim()} data-product={product}>
      <div className="ox-header-inner">
        <Link href="/" className="ox-wordmark" aria-label="0xNothing home">
          <span className="ox-wordmark-mark" aria-hidden="true">N</span>
          <span>0x<b>{current.name.toUpperCase()}</b></span>
        </Link>
        <nav className="ox-switcher" aria-label="0xNothing products">
          {PRODUCTS.map((entry) => (
            <Link key={entry.id} href={entry.href} data-product={entry.id} className={entry.id === product ? "active" : undefined} aria-current={entry.id === product ? "true" : undefined}>
              0x{entry.name}
            </Link>
          ))}
        </nav>
        <nav className="ox-nav" aria-label={`0x${current.name} navigation`}>{navLinks(false)}</nav>
        <div className="ox-header-actions">
          {mounted && wrongChain ? (
            <button type="button" className="ox-network-pill" data-state="wrong" disabled={switching} onClick={() => switchChain({ chainId: CHAIN_ID }, { onError: (error) => notify("error", "Network switch failed", error.message) })}>
              <i aria-hidden="true" />{switching ? "Switching" : "Switch to LiteForge"}
            </button>
          ) : (
            <span className="ox-network-pill" data-state="ok" title={`LiteForge testnet · chain ${CHAIN_ID}`}><i aria-hidden="true" />LiteForge</span>
          )}
          {mounted && isConnected && address ? (
            <div className="ox-wallet">
              <button ref={walletButton} type="button" className="ox-wallet-button" aria-expanded={walletOpen} aria-controls="ox-wallet-menu" title={address}
                onClick={() => setWalletOpen((open) => !open)}>
                {!wrongChain ? (
                  <span className="ox-wallet-balances" aria-label="Wallet balances">
                    <span>{compact(nusd.data, 18, 2)}<small>NUSD</small></span>
                    <span>{native.data ? compact(native.data.value, native.data.decimals, 3) : "--"}<small>zkLTC</small></span>
                  </span>
                ) : null}
                <span className="ox-wallet-avatar" aria-hidden="true" style={{ "--seed": `${parseInt(address.slice(2, 8), 16) % 360}deg` } as React.CSSProperties} />
                <span className="ox-wallet-address">{shortenAddress(address)}</span>
                <CaretDown size={12} aria-hidden="true" />
              </button>
              {walletOpen ? (
                <div id="ox-wallet-menu" ref={walletMenu} className="ox-wallet-menu" role="menu">
                  <div className="ox-wallet-menu-summary"><span>Connected wallet</span><strong>{shortenAddress(address)}</strong></div>
                  <button type="button" role="menuitem" onClick={() => void copyAddress()}><Copy size={15} aria-hidden="true" />Copy address</button>
                  <a role="menuitem" href={getAddressExplorerUrl(address)} target="_blank" rel="noopener noreferrer"><ArrowSquareOut size={15} aria-hidden="true" />View on explorer</a>
                  <button type="button" role="menuitem" className="danger" onClick={() => { closeWallet(); disconnect(); }}><SignOut size={15} aria-hidden="true" />Disconnect</button>
                </div>
              ) : null}
            </div>
          ) : mounted ? (
            <button type="button" className="ox-connect" disabled={connecting} onClick={connectWallet}>
              <Wallet size={16} aria-hidden="true" />{connecting ? "Connecting" : "Connect"}
            </button>
          ) : (
            <span className="ox-wallet-placeholder" aria-hidden="true" />
          )}
          <ThemeToggle />
          <button ref={menuButton} type="button" className="ox-menu-button" aria-label={menuOpen ? "Close navigation" : "Open navigation"}
            aria-expanded={menuOpen} aria-controls="ox-mobile-navigation" onClick={() => setMenuOpen((open) => !open)}>
            {menuOpen ? <X size={18} weight="bold" aria-hidden="true" /> : <List size={18} weight="bold" aria-hidden="true" />}
          </button>
        </div>
      </div>
      {menuOpen ? (
        <div id="ox-mobile-navigation" className="ox-mobile-panel">
          <nav className="ox-mobile-nav" aria-label={`Mobile 0x${current.name} navigation`}>{navLinks(true)}</nav>
          <nav className="ox-switcher ox-switcher-mobile" aria-label="0xNothing products">
            {PRODUCTS.map((entry) => (
              <Link key={entry.id} href={entry.href} data-product={entry.id} className={entry.id === product ? "active" : undefined} onClick={() => setMenuOpen(false)}>0x{entry.name}</Link>
            ))}
          </nav>
        </div>
      ) : null}
    </header>
  );
}
