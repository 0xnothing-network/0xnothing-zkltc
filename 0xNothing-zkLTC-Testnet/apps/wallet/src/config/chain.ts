import { defineChain } from "viem";

/**
 * Chain + endpoint constants, mirrored from
 * apps/web/config/wagmi.ts and apps/web/lib/publicConfig.ts.
 *
 * LitVM remains a literal built-in network. Optional custom profiles live in
 * the validated wallet settings layer, so changing them is explicit and local
 * rather than an invisible environment override.
 */
export const LITVM_CHAIN_ID = 4441;

export const LITVM_RPC_URL = "https://liteforge.rpc.caldera.xyz/infra-partner-http";
export const LITVM_EXPLORER_URL = "https://liteforge.explorer.caldera.xyz";
export const MULTICALL3_ADDRESS = "0xca11bde05977b3631167028862be2a173976ca11" as const;

export const litvm = defineChain({
  id: LITVM_CHAIN_ID,
  name: "LitVM LiteForge",
  nativeCurrency: { name: "zkLTC", symbol: "zkLTC", decimals: 18 },
  rpcUrls: { default: { http: [LITVM_RPC_URL] } },
  blockExplorers: { default: { name: "LiteForge Explorer", url: LITVM_EXPLORER_URL } },
  contracts: { multicall3: { address: MULTICALL3_ADDRESS, blockCreated: 1 } },
});

/** `eth_chainId` / `wallet_switchEthereumChain` speak hex. */
export const LITVM_CHAIN_ID_HEX = `0x${LITVM_CHAIN_ID.toString(16)}` as const;

export function txUrl(hash: string, network?: { explorerUrl: string }): string {
  const base = network?.explorerUrl ?? LITVM_EXPLORER_URL;
  return base ? `${base}/tx/${hash}` : "";
}

export function addressUrl(address: string, network?: { explorerUrl: string }): string {
  const base = network?.explorerUrl ?? LITVM_EXPLORER_URL;
  return base ? `${base}/address/${address}` : "";
}
