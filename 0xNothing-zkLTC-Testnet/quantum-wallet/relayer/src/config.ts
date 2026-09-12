// SPDX-License-Identifier: MIT
// Runtime configuration for the sponsor relayer. Everything is read from the
// environment so the same binary runs against LiteForge or a local anvil.

import { isAddress } from "viem";

export interface RelayConfig {
  port: number;
  rpcUrl: string;
  chainId: number;
  factory: `0x${string}`;
  /** QuantumRelayHub, or null if no hub is deployed on this chain yet.
   *
   * Optional on purpose: the relayer works without it (the sponsor pays
   * directly), and a hub address is only needed by third-party relayer nodes,
   * which discover it from /health. A wrong value here would send nodes to a
   * contract that refunds nobody, so it is validated like an address, not
   * passed through. */
  relayHub: `0x${string}` | null;
  /** Sponsor key. Absent => "simulate-only" mode (health shows sponsor: null). */
  sponsorKey: `0x${string}` | null;
  /** Max relayed requests per wallet per window. */
  rateMax: number;
  rateWindowMs: number;
  /** Hard caps on request size (defense in depth). */
  maxBodyBytes: number;
  maxCallsPerOp: number;
  maxCalldataBytesPerOp: number;
  validUntilMaxSkewSec: number;
}

function hexOr<T>(v: string | undefined, tag: string): T {
  if (v === undefined) throw new Error(`${tag} env var missing`);
  return v as T;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): RelayConfig {
  const port = Number(env.QW_RELAY_PORT ?? 8787);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error("QW_RELAY_PORT invalid");

  const rpcUrl = env.QW_RPC_URL ?? "https://liteforge.rpc.caldera.xyz/infra-partner-http";
  if (!/^https?:\/\//.test(rpcUrl)) throw new Error("QW_RPC_URL must be http(s)");

  const chainId = Number(env.QW_CHAIN_ID ?? 4441);

  const factory = hexOr<`0x${string}`>(env.QW_FACTORY, "QW_FACTORY");
  if (!isAddress(factory)) throw new Error("QW_FACTORY is not an address");

  let relayHub: `0x${string}` | null = null;
  const hub = env.QW_RELAY_HUB;
  if (hub !== undefined && hub !== "") {
    if (!isAddress(hub)) throw new Error("QW_RELAY_HUB is not an address");
    relayHub = hub as `0x${string}`;
  }

  let sponsorKey: `0x${string}` | null = null;
  // QW_SPONSOR_KEY is canonical. quantum-wallet/.env.local carries the dev key as
  // PRIVATE_KEY (used both to deploy the factory and to fund relays), so it is an
  // accepted alias — the secret is never duplicated into a QW_* name.
  const sk = env.QW_SPONSOR_KEY ?? env.PRIVATE_KEY;
  if (sk !== undefined && sk !== "") {
    // Tolerate both 0x-prefixed (66) and raw (64) hex; normalize to lowercase.
    const raw = sk.trim().replace(/^0x/i, "");
    if (!/^[0-9a-fA-F]{64}$/.test(raw)) {
      throw new Error("QW_SPONSOR_KEY must be a 32-byte private key (64 hex, 0x optional)");
    }
    sponsorKey = `0x${raw.toLowerCase()}` as `0x${string}`;
  }

  return {
    port,
    rpcUrl,
    chainId,
    factory,
    relayHub,
    sponsorKey,
    rateMax: Number(env.QW_RATE_MAX ?? 120),
    rateWindowMs: Number(env.QW_RATE_WINDOW_MS ?? 60_000),
    maxBodyBytes: Number(env.QW_MAX_BODY ?? 262_144),
    maxCallsPerOp: Number(env.QW_MAX_CALLS ?? 16),
    maxCalldataBytesPerOp: Number(env.QW_MAX_CALLDATA ?? 100_000),
    validUntilMaxSkewSec: Number(env.QW_MAX_VALID_UNTIL ?? 3_600),
  };
}
