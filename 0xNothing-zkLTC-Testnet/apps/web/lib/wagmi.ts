import { createConfig } from "wagmi";
import { litvmTransport } from "@/lib/rpcTransport";
import { injected } from "wagmi/connectors/injected";
import { litvm } from "@/config/wagmi";

const connectors = [injected()];

export const wagmiConfig = createConfig({
  ssr: true,
  chains: [litvm],
  connectors,
  // Only transaction receipt waits poll with this. LiteForge mines a block every
  // ~0.25 s, so a 4 s cadence kept each confirmed step waiting ~4 s for its UI.
  pollingInterval: 1_000,
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
