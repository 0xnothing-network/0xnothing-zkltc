"use client";

import { useState } from "react";
import { formatUnits } from "viem";
import { useAccount, useBalance, useDisconnect, useReadContract } from "wagmi";
import { litvm } from "@/config/wagmi";
import { nusdAbi } from "@/features/pump/abis";
import { NUSD_CONFIGURED, PUMP_NUSD_ADDRESS } from "@/features/pump/config";
import { getAddressExplorerUrl } from "@/lib/explorer";
import { Button } from "@/components/ui/Button";
import { PixelIdenticon } from "@/components/ui/TokenLogo";
import { cx } from "@/components/ui/cx";
import { useWalletModal } from "./WalletModalProvider";
import { usePopover } from "./usePopover";
import { ExternalLink } from "@/components/ExternalLink";

export function shortenAddress(address: string): string {
  return address.length > 10 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address;
}

function formatBalance(value: bigint | undefined, decimals = 18): string {
  if (value === undefined) return "—";
  const number = Number(formatUnits(value, decimals));
  if (number === 0) return "0";
  if (number < 0.0001) return "<0.0001";
  return number.toLocaleString("en-US", { maximumFractionDigits: 4 });
}

/** Connect button when disconnected; account menu (balances, copy, explorer, disconnect) when connected. */
export function WalletMenu() {
  const { address, isConnected, chainId, isConnecting, isReconnecting } = useAccount();
  const { disconnect } = useDisconnect();
  const walletModal = useWalletModal();
  const { open, toggle, close, triggerRef, panelRef } = usePopover();
  const [copied, setCopied] = useState(false);
  const onNetwork = Boolean(isConnected && chainId === litvm.id);

  const native = useBalance({ address, chainId: litvm.id, query: { enabled: Boolean(address && onNetwork) } });
  const nusd = useReadContract({
    address: PUMP_NUSD_ADDRESS,
    abi: nusdAbi,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    chainId: litvm.id,
    query: { enabled: Boolean(address && onNetwork && NUSD_CONFIGURED) },
  });

  if (!isConnected || !address) {
    return (
      <Button size="md" onClick={() => walletModal?.openWalletModal()} loading={isReconnecting || isConnecting}>
        Connect wallet
      </Button>
    );
  }

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className="relative">
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="true"
        aria-expanded={open}
        onClick={toggle}
        className="inline-flex h-10 items-center gap-2 rounded-full border border-line bg-surface-2 pl-1.5 pr-3 font-num text-[13px] text-fg hover:border-line-strong focus-ring"
      >
        <PixelIdenticon seed={address} size={28} />
        {onNetwork && nusd.data !== undefined ? (
          <span className="tnum text-fg-2 max-md:hidden">{formatBalance(nusd.data)} NUSD</span>
        ) : null}
        <span>{shortenAddress(address)}</span>
      </button>
      {open ? (
        <div
          ref={panelRef}
          className="absolute right-0 top-[calc(100%+8px)] z-[80] w-72 rounded-ui-lg border border-line-strong bg-surface-1 p-3 shadow-e2"
        >
          <div className="flex items-center gap-3 px-1 pb-3">
            <PixelIdenticon seed={address} size={36} />
            <div className="min-w-0">
              <p className="font-num text-sm text-fg">{shortenAddress(address)}</p>
              <p className="font-ui text-xs text-fg-3">{onNetwork ? litvm.name : "Wrong network"}</p>
            </div>
          </div>
          {onNetwork ? (
            <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-ui-md border border-line bg-line" aria-live="polite">
              <div className="bg-surface-2 p-2.5">
                <dt className="font-ui text-xs text-fg-3">zkLTC</dt>
                <dd className="font-num tnum text-sm text-fg">{formatBalance(native.data?.value, native.data?.decimals)}</dd>
              </div>
              <div className="bg-surface-2 p-2.5">
                <dt className="font-ui text-xs text-fg-3">NUSD</dt>
                <dd className="font-num tnum text-sm text-fg">{NUSD_CONFIGURED ? formatBalance(nusd.data) : "—"}</dd>
              </div>
            </dl>
          ) : null}
          <div className="mt-2 grid">
            <button type="button" onClick={() => void copy()} className={menuItem}>
              {copied ? "Address copied" : "Copy address"}
            </button>
            <ExternalLink href={getAddressExplorerUrl(address)} className={menuItem}>
              View on explorer ↗
            </ExternalLink>
            <button
              type="button"
              onClick={() => { close(); disconnect(); }}
              className={cx(menuItem, "text-negative hover:text-negative")}
            >
              Disconnect
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

const menuItem = "flex h-10 items-center rounded-ui-sm px-2 text-left font-ui text-sm text-fg-2 hover:bg-surface-3 hover:text-fg focus-ring";
