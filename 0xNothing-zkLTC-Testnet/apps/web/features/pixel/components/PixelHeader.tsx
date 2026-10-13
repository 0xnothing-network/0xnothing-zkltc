"use client";

import { useEffect, useRef } from "react";
import { usePathname } from "next/navigation";
import { useAccount, useSwitchChain } from "wagmi";
import { ProductHeader, type HeaderNotice } from "@/components/ProductHeader";
import { useToast } from "@/components/Toast";
import { shortHashOrAddr } from "@/lib/errors";
import { LITVM_CHAIN_ID } from "@/lib/chainSwitch";

const PIXEL_NAV = [
  { href: "/0xpixel", label: "Draw" },
  { href: "/0xpixel/gallery", label: "Gallery" },
  { href: "/0xpixel/marketplace", label: "Marketplace" },
] as const;

function isActivePixel(pathname: string | null, href: string): boolean {
  if (!pathname) return false;
  if (href === "/0xpixel") return pathname === "/0xpixel";
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function PixelHeader() {
  const pathname = usePathname();
  const toast = useToast();
  const { address, isConnected, chainId } = useAccount();
  const { switchChain } = useSwitchChain();
  const previous = useRef<{ connected: boolean; address: string | null } | null>(null);

  // 0xPixel asks the wallet to move to LitVM as soon as it connects elsewhere.
  useEffect(() => {
    if (!isConnected || !chainId || chainId === LITVM_CHAIN_ID) return;
    toast.info("Switching to LitVM", "Please confirm the network switch in your wallet");
    switchChain({ chainId: LITVM_CHAIN_ID });
  }, [isConnected, chainId, switchChain, toast]);

  useEffect(() => {
    const before = previous.current;
    previous.current = { connected: isConnected, address: address ?? null };
    if (!before) return;
    if (!before.connected && isConnected && address) toast.success("Wallet connected", `Connected as ${shortHashOrAddr(address)}`);
    else if (before.connected && !isConnected && before.address) toast.info("Wallet disconnected", `Removed ${shortHashOrAddr(before.address)}`);
  }, [isConnected, address, toast]);

  const notify: HeaderNotice = (kind, title, message) => {
    if (kind === "success") toast.success(title, message);
    else if (kind === "warning") toast.warning(title, message);
    else toast.error(title, message);
  };
  return <ProductHeader product="pixel" nav={PIXEL_NAV} isActive={(href) => isActivePixel(pathname, href)} notify={notify} />;
}
