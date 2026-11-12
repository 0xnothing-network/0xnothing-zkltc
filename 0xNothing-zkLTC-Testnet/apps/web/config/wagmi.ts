import { defineChain } from "viem";
import {
  LITVM_EXPLORER_URL,
  LITVM_RPC_URL,
  MULTICALL3_ADDRESS,
} from "@/lib/publicConfig";

export { LITVM_RPC_URL } from "@/lib/publicConfig";

export const litvm = defineChain({
  id: 4441,
  name: "LitVM LiteForge",
  nativeCurrency: { name: "zkLTC", symbol: "zkLTC", decimals: 18 },
  rpcUrls: {
    default: {
      http: [LITVM_RPC_URL],
    },
  },
  blockExplorers: {
    default: {
      name: "LiteForge Explorer",
      url: LITVM_EXPLORER_URL,
    },
  },
  contracts: {
    multicall3: {
      address: MULTICALL3_ADDRESS,
      blockCreated: 1,
    },
  },
});
