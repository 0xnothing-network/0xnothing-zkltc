import type { Address } from "viem";
import { deployment } from "@fi/config/deployment";

export function useActiveDexRouter(): Address | undefined {
  // The published testnet factory predates router(), so probing it produces a
  // permanent revert and briefly destabilizes every DEX screen. Deployment
  // metadata is the fail-closed source of truth for this release.
  return deployment.contracts.dexRouter;
}
