import type { Hex } from "viem";
import { LITVM_CHAIN_ID, LITVM_EXPLORER_URL } from "../../config/chain";

/**
 * Wiring for the 0xQuantum post-quantum wallet inside this extension.
 *
 * LiteForge-only: the deployed QuantumWalletFactory and the sponsor relayer live
 * on chain 4441. The factory address is pinned after `forge script
 * DeployFactory` runs against LiteForge; VITE_QUANTUM_FACTORY (build-time) wins
 * when the same dist is pointed at a fresh deployment, and
 * VITE_QUANTUM_RELAYER overrides the local sponsor for a dev test.
 */
export const QUANTUM_CHAIN_ID = LITVM_CHAIN_ID;
export const QUANTUM_EXPLORER = LITVM_EXPLORER_URL;
// `import.meta.env?.` — safe when this module is loaded outside Vite (node
// tests); Vite inlines the real object at build time.
export const QUANTUM_RELAYER_URL =
  (import.meta.env?.VITE_QUANTUM_RELAYER as string | undefined) ?? "http://127.0.0.1:8787";
/** Placeholder until the deploy lands; VITE_QUANTUM_FACTORY overrides. */
export const QUANTUM_FACTORY: Hex =
  (import.meta.env?.VITE_QUANTUM_FACTORY as Hex | undefined)
  ?? "0x0000000000000000000000000000000000000000";

/**
 * QuantumRelayHub — the vault that reimburses whoever submits a signed intent.
 *
 * `null` when unset, and every consumer must handle that: the hub is deployed
 * after the factory, and a build pointed at a hub that does not exist would have
 * its relayer node pay gas it can never claim back. The relayer node also reads
 * the address from the board's /health, so a stale build can be corrected at
 * runtime rather than needing a rebuild.
 */
export const QUANTUM_RELAY_HUB: Hex | null =
  (import.meta.env?.VITE_QUANTUM_RELAY_HUB as Hex | undefined) ?? null;
