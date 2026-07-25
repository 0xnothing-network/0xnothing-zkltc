"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useAccount, useConnect, useDisconnect, useSwitchChain } from "wagmi";
import { getAddressExplorerUrl, shortenAddress } from "@/lib/contract";
import { useToast } from "@/components/Toast";
import { normalizeError, shortHashOrAddr } from "@/lib/errors";
import { LITVM_CHAIN_ID } from "@/lib/chainSwitch";

const PIXEL_NAV = [
  { href: "/0xpixel", label: "Draw" },
  { href: "/0xpixel/gallery", label: "Gallery" },
  { href: "/0xpixel/marketplace", label: "Marketplace" },
] as const;

function isActivePixel(pathname: string | null, href: string): boolean {
  if (!pathname) return false;
  // Base path without subpages (exact match only)
  if (href === "/0xpixel") return pathname === "/0xpixel";
  // Subpages (match exact or starts with for nested routes)
  return pathname === href || pathname.startsWith(href + "/");
}

export function PixelHeader() {
  return <AppHeader />;
}

function AppHeader() {
  const [mounted, setMounted] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [addressMenuOpen, setAddressMenuOpen] = useState(false);
  const [addressMenuPosition, setAddressMenuPosition] = useState<{
    top: number;
    left: number;
  } | null>(null);
  const pathname = usePathname();

  const { address, isConnected, chainId } = useAccount();
  const { connectors, connect, isPending, error: connectError } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChain, isPending: isSwitching } = useSwitchChain();
  const toast = useToast();

  const addressMenuRef = useRef<HTMLDivElement>(null);
  const addressMenuPortalRef = useRef<HTMLDivElement>(null);
  const addressButtonRef = useRef<HTMLButtonElement>(null);
  const mobileAddressButtonRef = useRef<HTMLButtonElement>(null);
  const prevConnectedRef = useRef<boolean | null>(null);
  const prevAddressRef = useRef<string | null>(null);

  const updateAddressMenuPosition = useCallback(() => {
    const button =
      (window.innerWidth >= 640 ? addressButtonRef.current : mobileAddressButtonRef.current) ??
      addressButtonRef.current ??
      mobileAddressButtonRef.current;

    if (!button) return;

    const rect = button.getBoundingClientRect();
    const menuWidth = 224;
    const edgePadding = 8;
    const top = rect.bottom + 10;
    const left = Math.max(
      edgePadding,
      Math.min(rect.right - menuWidth, window.innerWidth - menuWidth - edgePadding)
    );

    setAddressMenuPosition({ top, left });
  }, []);

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    setMobileMenuOpen(false);
    setAddressMenuOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!addressMenuOpen) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      if (addressMenuRef.current?.contains(target)) return;
      if (addressMenuPortalRef.current?.contains(target)) return;
      setAddressMenuOpen(false);
    };
    const escHandler = (e: KeyboardEvent) => {
      if (e.key === "Escape") setAddressMenuOpen(false);
    };
    document.addEventListener("mousedown", handler);
    document.addEventListener("keydown", escHandler);
    return () => {
      document.removeEventListener("mousedown", handler);
      document.removeEventListener("keydown", escHandler);
    };
  }, [addressMenuOpen]);

  useEffect(() => {
    if (!addressMenuOpen) {
      setAddressMenuPosition(null);
      return;
    }

    updateAddressMenuPosition();
    window.addEventListener("resize", updateAddressMenuPosition);
    window.addEventListener("scroll", updateAddressMenuPosition, true);

    return () => {
      window.removeEventListener("resize", updateAddressMenuPosition);
      window.removeEventListener("scroll", updateAddressMenuPosition, true);
    };
  }, [addressMenuOpen, updateAddressMenuPosition]);

  // Auto-switch to LitVM when connected to wrong network
  useEffect(() => {
    if (!mounted || !isConnected || !chainId) return;
    if (chainId !== LITVM_CHAIN_ID && switchChain) {
      toast.info("Switching to LitVM", "Please confirm the network switch in your wallet");
      switchChain({ chainId: LITVM_CHAIN_ID });
    }
  }, [mounted, isConnected, chainId, switchChain, toast]);

  useEffect(() => {
    if (!mounted) return;
    const wasConnected = prevConnectedRef.current;
    const wasAddress = prevAddressRef.current;
    prevConnectedRef.current = isConnected;
    prevAddressRef.current = address ?? null;

    if (wasConnected === null) return;
    if (wasConnected === false && isConnected && address) {
      toast.success("Wallet connected", `Connected as ${shortHashOrAddr(address)}`);
    } else if (wasConnected === true && !isConnected) {
      if (wasAddress) {
        toast.info("Wallet disconnected", `Removed ${shortHashOrAddr(wasAddress)}`);
      }
    }
  }, [isConnected, address, mounted, toast]);

  useEffect(() => {
    if (!connectError) return;
    const normalized = normalizeError(connectError);
    toast.show({
      title: normalized.title,
      description: normalized.description,
      kind: normalized.kind,
    });
  }, [connectError, toast]);

  const handleConnect = () => {
    const connector = connectors[0];
    if (!connector) {
      toast.warning(
        "No wallet detected",
        "Install MetaMask or another Web3 wallet, then refresh the page."
      );
      return;
    }
    connect({ connector });
  };

  const handleCopyAddress = async () => {
    if (!address) return;
    try {
      await navigator.clipboard.writeText(address);
      toast.success("Address copied", shortHashOrAddr(address));
    } catch {
      toast.error("Couldn't copy", "Your browser blocked clipboard access.");
    }
  };

  const wrongNetwork = isConnected && chainId && chainId !== LITVM_CHAIN_ID;

  const toggleAddressMenu = () => {
    if (!addressMenuOpen) {
      updateAddressMenuPosition();
    }
    setAddressMenuOpen((v) => !v);
  };

  const renderAddressMenu = () => {
    if (!mounted || !addressMenuOpen || !addressMenuPosition || typeof document === "undefined") {
      return null;
    }

    return createPortal(
      <div
        ref={addressMenuPortalRef}
        role="menu"
        style={{
          position: "fixed",
          top: addressMenuPosition.top,
          left: addressMenuPosition.left,
          zIndex: 9999,
        }}
        className="w-56 overflow-hidden border border-white/[0.14] bg-[#050507]/98 shadow-[6px_6px_0_0_var(--pixel-shadow),0_24px_70px_rgba(0,0,0,0.72)] backdrop-blur-md animate-slideDown"
      >
        <button
          type="button"
          role="menuitem"
          onClick={handleCopyAddress}
          className="w-full flex items-center gap-2 px-3.5 py-2.5 text-sm text-white hover:bg-white/[0.08] transition-colors text-left"
          style={{ fontFamily: "var(--font-departure)" }}
        >
          <svg width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
            <rect x="9" y="9" width="13" height="13" rx="2" />
            <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
          </svg>
          Copy address
        </button>
        <a
          role="menuitem"
          href={address ? getAddressExplorerUrl(address) : "#"}
          target="_blank"
          rel="noopener noreferrer"
          className="w-full flex items-center gap-2 px-3.5 py-2.5 text-sm text-white hover:bg-white/[0.08] transition-colors"
          style={{ fontFamily: "var(--font-departure)" }}
        >
          <svg width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
            <path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6" />
            <path d="M15 3h6v6" />
            <path d="M10 14L21 3" />
          </svg>
          View on Explorer
        </a>
        {wrongNetwork && (
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setAddressMenuOpen(false);
              switchChain?.({ chainId: LITVM_CHAIN_ID });
            }}
            className="w-full flex items-center gap-2 px-3.5 py-2.5 text-sm text-amber-300 hover:bg-amber-500/12 transition-colors text-left"
            style={{ fontFamily: "var(--font-departure)" }}
          >
            <svg width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              <path d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
            </svg>
            Switch to LitVM
          </button>
        )}
        <div className="h-px bg-white/[0.1]" />
        <button
          type="button"
          role="menuitem"
          onClick={() => {
            setAddressMenuOpen(false);
            disconnect();
          }}
          className="w-full flex items-center gap-2 px-3.5 py-2.5 text-sm text-red-300 hover:text-red-200 hover:bg-red-500/12 transition-colors text-left"
          style={{ fontFamily: "var(--font-departure)" }}
        >
          <svg width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
            <path d="M16 17l5-5-5-5M21 12H9M9 21H4a2 2 0 01-2-2V5a2 2 0 012-2h5" />
          </svg>
          Disconnect
        </button>
      </div>,
      document.body
    );
  };

  return (
    <>
      <header className="pixel-app-header sticky top-0 z-[80] border-b border-white/[0.08] bg-[#07070d]/86 backdrop-blur-xl supports-[backdrop-filter]:bg-[#07070d]/72">
        <div className="max-w-7xl mx-auto px-3 py-2.5 sm:px-5 sm:py-3.5 flex items-center justify-between gap-2 sm:gap-4">
          <div className="flex min-w-0 items-center gap-3 sm:gap-4">
            <Link href="/" className="flex items-center group">
              <span
                className="text-white font-bold text-sm sm:text-base uppercase tracking-[0.12em]"
                style={{ fontFamily: "var(--font-departure)" }}
              >
                0xPixel
              </span>
            </Link>
          </div>

          <nav className="hidden md:flex items-center gap-2">
            {PIXEL_NAV.map((link) => {
              const active = isActivePixel(pathname, link.href);
              return (
                <Link
                  key={link.href}
                  href={link.href}
                  aria-current={active ? "page" : undefined}
                  className={active ? "pixel-nav pixel-nav-active" : "pixel-nav"}
                >
                  {link.label}
                </Link>
              );
            })}
            <a
              href="https://x.com/0xnothing_net"
              target="_blank"
              rel="noopener noreferrer"
              className="pixel-nav-icon"
              aria-label="X / Twitter"
            >
              <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
                <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
              </svg>
            </a>
          </nav>

          <div className="flex min-w-0 items-center gap-1.5 sm:gap-2">
            {mounted && isConnected && address ? (
              <div className="flex items-center gap-2">
                {wrongNetwork && (
                  <button
                    type="button"
                    onClick={() => switchChain?.({ chainId: LITVM_CHAIN_ID })}
                    disabled={isSwitching}
                    className="pixel-btn-soft pixel-btn-soft-amber pixel-btn-soft-sm hidden sm:block"
                  >
                    {isSwitching ? "Switching..." : "Switch to LitVM"}
                  </button>
                )}

                <div ref={addressMenuRef} className="relative">
                  <button
                    ref={addressButtonRef}
                    type="button"
                    onClick={toggleAddressMenu}
                    aria-expanded={addressMenuOpen}
                    aria-haspopup="menu"
                    title={address}
                    className="hidden sm:flex items-center gap-2 border border-[rgba(124,124,255,0.32)] bg-white/[0.045] px-3 py-2 shadow-[3px_3px_0_0_var(--pixel-shadow)] transition-all duration-150 hover:-translate-x-0.5 hover:-translate-y-0.5 hover:bg-white/[0.07]"
                  >
                    <span className={`w-2 h-2 ${wrongNetwork ? "bg-amber-400" : "bg-emerald-400 animate-pulse"}`} />
                    <span className="text-white text-xs font-mono">
                      {shortenAddress(address)}
                    </span>
                    <svg
                      className={`w-3 h-3 text-[#94A3B8] transition-transform duration-150 ${
                        addressMenuOpen ? "rotate-180" : ""
                      }`}
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      viewBox="0 0 24 24"
                    >
                      <path strokeLinecap="round" d="M6 9l6 6 6-6" />
                    </svg>
                  </button>

                  <button
                    ref={mobileAddressButtonRef}
                    type="button"
                    onClick={toggleAddressMenu}
                    aria-expanded={addressMenuOpen}
                    aria-haspopup="menu"
                    title={address}
                    className="sm:hidden flex min-w-0 items-center gap-1.5 border border-[rgba(124,124,255,0.3)] bg-white/[0.045] px-2 py-1.5 shadow-[2px_2px_0_0_var(--pixel-shadow)]"
                  >
                    <span className={`w-2 h-2 ${wrongNetwork ? "bg-amber-400" : "bg-emerald-400"}`} />
                    <span className="text-white text-[10px] font-mono">
                      {shortenAddress(address)}
                    </span>
                  </button>
                </div>
              </div>
            ) : mounted ? (
              <button
                type="button"
                onClick={handleConnect}
                disabled={isPending}
                className="pixel-connect-wallet pixel-btn pixel-btn-indigo pixel-btn-sm relative overflow-hidden whitespace-nowrap"
                style={{ fontFamily: "var(--font-departure)" }}
              >
                <span
                  aria-hidden="true"
                  className="absolute inset-0 -translate-x-full group-hover:translate-x-full transition-transform duration-700 bg-gradient-to-r from-transparent via-white/20 to-transparent"
                />
                <span className="relative flex items-center gap-1.5">
                  {isPending ? (
                    <>
                      <span className="w-3 h-3 border border-white/40 border-t-white rounded-full animate-spin" />
                      CONNECTING...
                    </>
                  ) : (
                    <>
                      <svg width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                        <path d="M21 12V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2h7" />
                        <path d="M16 16l2 2 4-4" />
                      </svg>
                      <span className="hidden min-[390px]:inline">CONNECT WALLET</span>
                      <span className="min-[390px]:hidden">CONNECT</span>
                    </>
                  )}
                </span>
              </button>
            ) : (
              <div className="pixel-connect-wallet flex h-9 w-32 items-center justify-center border text-[9px] font-bold">
                CONNECT WALLET
              </div>
            )}

            <button
              type="button"
              onClick={() => setMobileMenuOpen((v) => !v)}
              className="md:hidden flex h-10 w-10 flex-col items-center justify-center gap-1.5 border border-white/[0.08] bg-white/[0.035] shadow-[3px_3px_0_0_var(--pixel-shadow)] transition-colors hover:bg-white/[0.06]"
              aria-label="Toggle menu"
              aria-expanded={mobileMenuOpen}
            >
              <span
                className={`block w-5 h-px bg-white transition-all duration-200 ${
                  mobileMenuOpen ? "rotate-45 translate-y-1.5" : ""
                }`}
              />
              <span
                className={`block w-5 h-px bg-white transition-all duration-200 ${
                  mobileMenuOpen ? "opacity-0" : ""
                }`}
              />
              <span
                className={`block w-5 h-px bg-white transition-all duration-200 ${
                  mobileMenuOpen ? "-rotate-45 -translate-y-1.5" : ""
                }`}
              />
            </button>
          </div>
        </div>

        {mobileMenuOpen ? (
          <nav
            key="mobile-menu"
            className="md:hidden space-y-1 border-t border-white/[0.08] bg-[#07070d]/96 px-4 py-3 animate-slideDown"
          >
            <div className="px-3.5 py-2 text-xs text-[#64748B] uppercase tracking-wider" style={{ fontFamily: "var(--font-departure)" }}>
              0xPixel
            </div>
            {PIXEL_NAV.map((link) => {
              const active = isActivePixel(pathname, link.href);
              return (
                <Link
                  key={link.href}
                  href={link.href}
                  aria-current={active ? "page" : undefined}
                  className={
                    active
                      ? "pixel-nav-mobile pixel-nav-mobile-active"
                      : "pixel-nav-mobile"
                  }
                >
                  {active ? (
                    <span aria-hidden="true" className="w-1 h-3 bg-white/40 flex-shrink-0" />
                  ) : null}
                  {link.label}
                </Link>
              );
            })}
            <>
              <div className="h-px bg-[#2D2D44] my-2" />
              <a
                href="https://x.com/0xnothing_net"
                target="_blank"
                rel="noopener noreferrer"
                className="pixel-nav-mobile"
              >
                <svg className="w-4 h-4 flex-shrink-0" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
                </svg>
                Follow on X
              </a>
            </>
            {mounted && isConnected ? (
              <button
                type="button"
                onClick={() => disconnect()}
                className="pixel-nav-mobile pixel-nav-danger"
              >
                <svg
                  width="14"
                  height="14"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  viewBox="0 0 24 24"
                  className="flex-shrink-0"
                >
                  <path d="M16 17l5-5-5-5M21 12H9M9 21H4a2 2 0 01-2-2V5a2 2 0 012-2h5" />
                </svg>
                Disconnect
              </button>
            ) : null}
          </nav>
        ) : null}
      </header>
      {renderAddressMenu()}
    </>
  );
}
