import { createConfig } from "wagmi";
import { litvmTransport } from "@/lib/rpcTransport";
import { injected } from "wagmi/connectors/injected";
import { litvm } from "@/config/wagmi";

const connectors = [injected()];

export const wagmiConfig = createConfig({
  ssr: true,
  chains: [litvm],
  connectors,
  pollingInterval: 4_000,
  transports: {
    [litvm.id]: litvmTransport({
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
