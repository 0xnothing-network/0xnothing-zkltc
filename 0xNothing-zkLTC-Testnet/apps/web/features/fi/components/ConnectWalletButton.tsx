"use client";

import { Wallet } from "@phosphor-icons/react";
import { useConnect } from "wagmi";
import { useToast } from "@fi/components/Toast";

const NO_WALLET_MESSAGE = "Install or enable an EVM wallet in this browser, then try again.";

export function hasInjectedWallet(): boolean {
  if (typeof window === "undefined") return false;
  return Boolean((window as Window & { ethereum?: unknown }).ethereum);
}

export function friendlyWalletError(error: unknown): { title: string; message: string } {
  const message = error instanceof Error ? error.message.toLowerCase() : "";

  if (message.includes("user rejected") || message.includes("user denied") || message.includes("4001")) {
    return {
      title: "Connection cancelled",
      message: "Approve the connection request in your wallet when you are ready.",
    };
  }

  if (message.includes("provider not found") || message.includes("connector not found")) {
    return { title: "Wallet not found", message: NO_WALLET_MESSAGE };
  }

  if (message.includes("already pending") || message.includes("request pending")) {
    return {
      title: "Wallet request pending",
      message: "Open your wallet and finish the pending connection request.",
    };
  }

  return {
    title: "Wallet connection failed",
    message: "Unlock your wallet, check the connection request, then try again.",
  };
}

export function ConnectWalletButton({
  className = "fi-button fi-button-primary fi-button-block",
  label = "Connect wallet",
}: {
  className?: string;
  label?: string;
}) {
  const toast = useToast();
  const { connectors, connectAsync, isPending } = useConnect();

  async function connectWallet() {
    const connector = connectors.find((candidate) => candidate.type === "injected") ?? connectors[0];
    if (!connector || (connector.type === "injected" && !hasInjectedWallet())) {
      toast.show("Wallet not found", NO_WALLET_MESSAGE, "warning");
      return;
    }

    try {
      await connectAsync({ connector });
    } catch (error) {
      const friendlyError = friendlyWalletError(error);
      toast.show(friendlyError.title, friendlyError.message, "error");
    }
  }

  return (
    <button type="button" className={className} disabled={isPending} onClick={() => void connectWallet()}>
      <Wallet size={16} weight="bold" aria-hidden="true" />
      {isPending ? "Connecting" : label}
    </button>
  );
}
