import { createConfig, http } from "wagmi";
import { injected } from "wagmi/connectors/injected";
import { litvm } from "@/config/chain";
import { deployment } from "@/config/deployment";

export const wagmiConfig = createConfig({
  ssr: true,
  chains: [litvm],
  connectors: [injected()],
  transports: {
    [litvm.id]: http(deployment.chain.rpcUrl, {
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
