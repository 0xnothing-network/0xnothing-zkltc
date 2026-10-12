"use client";

import { useCallback } from "react";
import { useAccount, useSwitchChain } from "wagmi";
import { litvm } from "@/config/wagmi";
import { LITVM_ADD_CHAIN_PARAMETER } from "@/config/network";

/**
 * Single entry point for "Switch to LiteForge" (spec §6.2). Wraps wagmi
 * switchChain with addEthereumChainParameter so a wallet missing chain 4441
 * is offered to add it. Resolves true when the wallet ends up on LiteForge.
 */
export function useEnsureChain() {
  const { chainId, isConnected } = useAccount();
  const { switchChainAsync, isPending, error, reset } = useSwitchChain();
  const wrongNetwork = Boolean(isConnected && chainId !== litvm.id);

  const ensureChain = useCallback(async (): Promise<boolean> => {
    if (!wrongNetwork) return true;
    try {
      await switchChainAsync({ chainId: litvm.id, addEthereumChainParameter: LITVM_ADD_CHAIN_PARAMETER });
      return true;
    } catch {
      return false;
    }
  }, [switchChainAsync, wrongNetwork]);

  return { ensureChain, wrongNetwork, walletChainId: chainId, isSwitching: isPending, switchError: error, resetSwitchError: reset };
}
