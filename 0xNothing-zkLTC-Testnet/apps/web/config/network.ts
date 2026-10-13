import { litvm } from "@/config/wagmi";

/** Short network label used by the shell ("LiteForge · 4441"). */
export const NETWORK_SHORT_NAME = "LiteForge";

/**
 * EIP-3085 parameters so `switchChain` can add LiteForge when the wallet
 * doesn't know it yet (error 4902), instead of surfacing a raw error.
 */
export const LITVM_ADD_CHAIN_PARAMETER = {
  chainName: litvm.name,
  nativeCurrency: litvm.nativeCurrency,
  rpcUrls: [...litvm.rpcUrls.default.http],
  blockExplorerUrls: litvm.blockExplorers?.default.url ? [litvm.blockExplorers.default.url] : undefined,
};
