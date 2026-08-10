"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  ArrowSquareOut,
  ArrowsLeftRight,
  CaretDown,
  ChartLineUp,
  Coins,
  Copy,
  HandCoins,
  List,
  PiggyBank,
  SignOut,
  Vault,
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
import { erc20Abi } from "@fi/lib/abis/erc20";
import { deployment, explorerAddressUrl } from "@fi/config/deployment";
import { FI_BASE_PATH, fiPath } from "@fi/config/paths";
import { formatAmount, shortAddress } from "@fi/lib/format";
import { useToast } from "@fi/components/Toast";
import { friendlyWalletError, hasInjectedWallet } from "@fi/components/ConnectWalletButton";

const NAV_ITEMS = [
  { href: "/", label: "Swap", icon: ArrowsLeftRight },
  { href: "/pools", label: "Pools", icon: Coins },
  { href: "/farm", label: "Earn", icon: ChartLineUp },
  { href: "/lend", label: "Lend", icon: PiggyBank },
  { href: "/borrow", label: "Borrow", icon: HandCoins },
  { href: "/synth", label: "Synth", icon: Vault },
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
    if (!connectError) return;
    const friendlyError = friendlyWalletError(connectError);
    toast.show(friendlyError.title, friendlyError.message, "error");
  }, [connectError, toast]);

  const connectWallet = () => {
    const connector = connectors.find((candidate) => candidate.type === "injected") ?? connectors[0];
    if (!connector || (connector.type === "injected" && !hasInjectedWallet())) {
      toast.show("Wallet not found", "Install or enable an EVM wallet in this browser, then try again.", "warning");
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
          <Link href="/" className="fi-wordmark" aria-label="0xNothing home">
            <span>0x</span>FI
          </Link>

          <nav className="fi-nav fi-nav-desktop" aria-label="0xFi navigation">
            {NAV_ITEMS.map((item) => {
              const active = activePath(pathname, item.href);
              const Icon = item.icon;
              return (
                <Link
                  href={fiPath(item.href)}
                  key={item.href}
                  className={active ? "active" : undefined}
                  aria-current={active ? "page" : undefined}
                >
                  <Icon size={16} weight="regular" aria-hidden="true" />
                  <span>{item.label}</span>
                </Link>
              );
            })}
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
                  aria-expanded={walletOpen}
                  aria-controls="fi-wallet-options"
                  onClick={() => setWalletOpen((open) => !open)}
                  title={address}
                >
                  <Wallet size={15} aria-hidden="true" />
                  {shortAddress(address)}
                  <CaretDown size={12} aria-hidden="true" />
                </button>
                {walletOpen ? (
                  <div id="fi-wallet-options" ref={walletMenuRef} className="fi-wallet-menu" aria-label="Wallet options">
                    <div className="fi-wallet-menu-summary">
                      <span>Connected wallet</span>
                      <strong>{shortAddress(address, 7, 6)}</strong>
                    </div>
                    <button type="button" onClick={() => void copyAddress()}>
                      <Copy size={15} aria-hidden="true" /> Copy address
                    </button>
                    <a href={explorerAddressUrl(address)} target="_blank" rel="noreferrer">
                      <ArrowSquareOut size={15} aria-hidden="true" /> View on explorer
                    </a>
                    <button type="button" className="danger" onClick={() => disconnect()}>
                      <SignOut size={15} aria-hidden="true" /> Disconnect
                    </button>
                  </div>
                ) : null}
              </div>
            ) : mounted ? (
              <button type="button" className="fi-button fi-button-primary" disabled={connecting} onClick={connectWallet}>
                <Wallet size={15} weight="regular" aria-hidden="true" />
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
            {NAV_ITEMS.map((item) => {
              const active = activePath(pathname, item.href);
              const Icon = item.icon;
              return (
                <Link
                  href={fiPath(item.href)}
                  key={item.href}
                  className={active ? "active" : undefined}
                  aria-current={active ? "page" : undefined}
                >
                  <Icon size={17} weight="regular" aria-hidden="true" />
                  <span>{item.label}</span>
                </Link>
              );
            })}
          </nav>
        ) : null}
      </header>

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
