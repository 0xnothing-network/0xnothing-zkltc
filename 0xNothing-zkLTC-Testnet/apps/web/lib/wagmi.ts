import { createConfig, http } from "wagmi";
import { injected } from "wagmi/connectors/injected";
import { litvm, LITVM_RPC_URL } from "@/config/wagmi";

const connectors = [injected()];

export const wagmiConfig = createConfig({
  ssr: true,
  chains: [litvm],
  connectors,
  // EIP-6963: lists every installed wallet (MetaMask, Rabby, ...) in the
  // shell's WalletModal instead of only the first injected provider.
  multiInjectedProviderDiscovery: true,
  pollingInterval: 4_000,
  transports: {
    [litvm.id]: http(LITVM_RPC_URL, {
      batch: { batchSize: 100, wait: 10 },
      retryCount: 2,
      retryDelay: 300,
      timeout: 15_000,
    }),
  },
});

declare module "wagmi" {
  interface Register {
    config: typeof wagmiConfig;
  }
}
