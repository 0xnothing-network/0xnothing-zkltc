import { defineChain } from "viem";
import { deployment } from "@/config/deployment";

export const litvm = defineChain({
  id: deployment.chain.id,
  name: deployment.chain.name,
  nativeCurrency: { name: "zkLTC", symbol: "zkLTC", decimals: 18 },
  rpcUrls: { default: { http: [deployment.chain.rpcUrl] } },
  blockExplorers: {
    default: { name: "LiteForge Explorer", url: deployment.chain.explorerUrl },
  },
});
