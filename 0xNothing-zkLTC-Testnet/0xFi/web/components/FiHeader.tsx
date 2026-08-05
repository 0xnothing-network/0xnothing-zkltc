"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  ArrowSquareOut,
  CaretDown,
  Copy,
  List,
  SignOut,
  Wallet,
  X,
} from "@phosphor-icons/react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  useAccount,
  useBalance,
  useConnect,
  useDisconnect,
  useReadContract,
  useSwitchChain,
} from "wagmi";
import { erc20Abi } from "@/lib/abis/erc20";
import { deployment, explorerAddressUrl } from "@/config/deployment";
import { FI_BASE_PATH } from "@/config/paths";
import { formatAmount, shortAddress } from "@/lib/format";
import { useToast } from "@/components/Toast";

const MAIN_APP_HOME = "/";

const NAV_ITEMS = [
  { href: "/", label: "Trade" },
  { href: "/pools", label: "Pools" },
  { href: "/farm", label: "Farm" },
  { href: "/lend", label: "Lend" },
  { href: "/borrow", label: "Borrow" },
  { href: "/synth", label: "Synth" },
] as const;

function activePath(pathname: string, href: string): boolean {
  const localPath = pathname === FI_BASE_PATH
    ? "/"
    : pathname.startsWith(`${FI_BASE_PATH}/`) ? pathname.slice(FI_BASE_PATH.length) : pathname;
  if (href === "/") return localPath === "/" || localPath === "/swap" || localPath.startsWith("/pools/");
  if (href === "/pools") return localPath === "/pools";
  return localPath === href || localPath.startsWith(`${href}/`);
}

export function FiHeader() {
  const pathname = usePathname();
  const toast = useToast();
  const [mounted, setMounted] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [walletOpen, setWalletOpen] = useState(false);
  const walletButtonRef = useRef<HTMLButtonElement>(null);
  const walletMenuRef = useRef<HTMLDivElement>(null);
  const mobileButtonRef = useRef<HTMLButtonElement>(null);
  const { address, chainId, isConnected } = useAccount();
  const { connectors, connect, error: connectError, isPending: connecting } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChain, isPending: switching } = useSwitchChain();
  const wrongChain = Boolean(isConnected && chainId !== deployment.chain.id);
  const readsEnabled = Boolean(address && !wrongChain);

  const nativeBalance = useBalance({
    address,
    chainId: deployment.chain.id,
    query: { enabled: readsEnabled, refetchInterval: 15_000 },
  });
  const nusdBalance = useReadContract({
    address: deployment.contracts.nusd,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    chainId: deployment.chain.id,
    query: { enabled: Boolean(readsEnabled && deployment.contracts.nusd), refetchInterval: 15_000 },
  });

  useEffect(() => setMounted(true), []);
  useEffect(() => {
    setMobileOpen(false);
    setWalletOpen(false);
  }, [pathname]);

  const closeWallet = useCallback((restoreFocus = false) => {
    setWalletOpen(false);
    if (restoreFocus) requestAnimationFrame(() => walletButtonRef.current?.focus());
  }, []);

  useEffect(() => {
    if (!walletOpen) return;
    const onMouseDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!walletMenuRef.current?.contains(target) && !walletButtonRef.current?.contains(target)) {
        closeWallet();
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeWallet(true);
    };
    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("keydown", onKeyDown);
    requestAnimationFrame(() => walletMenuRef.current?.querySelector<HTMLElement>("button, a")?.focus());
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [closeWallet, walletOpen]);

  useEffect(() => {
    if (!mobileOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setMobileOpen(false);
        requestAnimationFrame(() => mobileButtonRef.current?.focus());
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [mobileOpen]);

  useEffect(() => {
    if (connectError) toast.show("Wallet connection failed", connectError.message, "error");
  }, [connectError, toast]);

  const connectWallet = () => {
    const connector = connectors[0];
    if (!connector) {
      toast.show("No wallet detected", "Install an injected wallet and refresh the page.", "warning");
      return;
    }
    connect({ connector });
  };

  const copyAddress = async () => {
    if (!address) return;
    try {
      await navigator.clipboard.writeText(address);
      toast.show("Address copied", shortAddress(address), "success");
    } catch {
      toast.show("Copy blocked", "The browser denied clipboard access.", "error");
    }
  };

  return (
    <>
      <header className="fi-header">
        <div className="fi-header-inner">
          <a href={MAIN_APP_HOME} className="fi-wordmark" aria-label="0xNothing home">
            <span>0x</span>FI
          </a>

          <nav className="fi-nav fi-nav-desktop" aria-label="0xFi navigation">
            {NAV_ITEMS.map((item) => (
              <Link
                href={item.href}
                key={item.href}
                className={activePath(pathname, item.href) ? "active" : undefined}
                aria-current={activePath(pathname, item.href) ? "page" : undefined}
              >
                {item.label}
              </Link>
            ))}
          </nav>

          {mounted && address && !wrongChain ? (
            <div className="fi-header-balances" aria-label="Wallet balances" aria-live="polite">
              <div><span>NUSD</span><strong>{deployment.contracts.nusd ? `$${formatAmount(nusdBalance.data, 18, 2)}` : "--"}</strong></div>
              <div><span>zkLTC</span><strong>{nativeBalance.data ? formatAmount(nativeBalance.data.value, nativeBalance.data.decimals, 3) : "--"}</strong></div>
            </div>
          ) : null}

          <div className="fi-wallet-actions">
            {mounted && wrongChain ? (
              <button
                type="button"
                className="fi-button fi-button-warning"
                disabled={switching}
                onClick={() => switchChain({ chainId: deployment.chain.id })}
              >
                {switching ? "Switching" : "Switch network"}
              </button>
            ) : mounted && isConnected && address ? (
              <div className="fi-wallet-menu-wrap">
                <button
                  ref={walletButtonRef}
                  type="button"
                  className="fi-button fi-button-muted fi-wallet-button"
                  aria-haspopup="menu"
                  aria-expanded={walletOpen}
                  onClick={() => setWalletOpen((open) => !open)}
                  title={address}
                >
                  <Wallet size={15} aria-hidden="true" />
                  {shortAddress(address)}
                  <CaretDown size={12} aria-hidden="true" />
                </button>
                {walletOpen ? (
                  <div ref={walletMenuRef} className="fi-wallet-menu" role="menu">
                    <div className="fi-wallet-menu-summary">
                      <span>Connected wallet</span>
                      <strong>{shortAddress(address, 7, 6)}</strong>
                    </div>
                    <button type="button" role="menuitem" onClick={() => void copyAddress()}>
                      <Copy size={15} aria-hidden="true" /> Copy address
                    </button>
                    <a role="menuitem" href={explorerAddressUrl(address)} target="_blank" rel="noreferrer">
                      <ArrowSquareOut size={15} aria-hidden="true" /> View on explorer
                    </a>
                    <button type="button" role="menuitem" className="danger" onClick={() => disconnect()}>
                      <SignOut size={15} aria-hidden="true" /> Disconnect
                    </button>
                  </div>
                ) : null}
              </div>
            ) : mounted ? (
              <button type="button" className="fi-button fi-button-primary" disabled={connecting} onClick={connectWallet}>
                <Wallet size={15} weight="bold" aria-hidden="true" />
                {connecting ? "Connecting" : "Connect"}
              </button>
            ) : (
              <div className="fi-wallet-placeholder" aria-hidden="true" />
            )}

            <button
              ref={mobileButtonRef}
              type="button"
              className="fi-icon-button fi-mobile-menu-button"
              aria-label={mobileOpen ? "Close navigation" : "Open navigation"}
              aria-expanded={mobileOpen}
              aria-controls="fi-mobile-navigation"
              onClick={() => setMobileOpen((open) => !open)}
            >
              {mobileOpen ? <X size={19} weight="bold" aria-hidden="true" /> : <List size={20} weight="bold" aria-hidden="true" />}
            </button>
          </div>
        </div>

        {mobileOpen ? (
          <nav id="fi-mobile-navigation" className="fi-nav-mobile" aria-label="Mobile 0xFi navigation">
            {NAV_ITEMS.map((item) => (
              <Link
                href={item.href}
                key={item.href}
                className={activePath(pathname, item.href) ? "active" : undefined}
                aria-current={activePath(pathname, item.href) ? "page" : undefined}
              >
                {item.label}
              </Link>
            ))}
          </nav>
        ) : null}
      </header>

      {mounted && wrongChain ? (
        <div className="fi-network-guard" role="alert">
          Wallet is connected to chain {chainId}. Transactions require LitVM chain {deployment.chain.id}.
          <button type="button" onClick={() => switchChain({ chainId: deployment.chain.id })}>Switch now</button>
        </div>
      ) : null}
    </>
  );
}
