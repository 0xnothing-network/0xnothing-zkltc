// SPDX-License-Identifier: MIT
// Read-only on-chain access: wallet state, counterfactual prediction, op
// simulation with revert decoding. No signing key material ever touches these
// functions.

import type { PublicClient } from "viem";
import {
  decodeErrorResult,
  encodeFunctionData,
  type Hex,
} from "viem";
import {
  quantumWalletAbi,
  quantumWalletFactoryAbi,
  quantumRelayHubAbi,
} from "./abi.ts";
import { encodeSigAndOpArgs } from "./encode.ts";
import type { QWalletOp, QSig } from "./encode.ts";

export interface WalletState {
  deployed: boolean;
  nonce: bigint;
  epoch: number;
  merkleRoot: Hex;
  leafIndex: number;
}

/** Current wallet state, or { deployed:false, ...zeros } if not yet deployed. */
export async function readWalletState(client: PublicClient, wallet: Hex): Promise<WalletState> {
  const code = await client.getCode({ address: wallet });
  if (!code || code === "0x") {
    return { deployed: false, nonce: 0n, epoch: 0, merkleRoot: "0x" + "00".repeat(32) as Hex, leafIndex: 0 };
  }
  const [nonce, epoch, merkleRoot, leafIndex] = await Promise.all([
    client.readContract({ address: wallet, abi: quantumWalletAbi, functionName: "nonce" }),
    client.readContract({ address: wallet, abi: quantumWalletAbi, functionName: "epoch" }),
    client.readContract({ address: wallet, abi: quantumWalletAbi, functionName: "merkleRoot" }),
    client.readContract({ address: wallet, abi: quantumWalletAbi, functionName: "leafIndex" }),
  ]);
  return { deployed: true, nonce, epoch: Number(epoch), merkleRoot, leafIndex: Number(leafIndex) };
}

/** CREATE2 prediction for a wallet root (counterfactual address). */
export async function predictWallet(
  client: PublicClient,
  factory: Hex,
  root0: Hex,
): Promise<Hex> {
  return client.readContract({
    address: factory,
    abi: quantumWalletFactoryAbi,
    functionName: "predictWallet",
    args: [root0],
  });
}

export interface SimulationResult {
  ok: boolean;
  gasEstimate: bigint | null;
  /** Human message of the first decoded revert (if any). */
  revert?: string;
}

/** eth_call + estimateGas for a signed executeSigned op (used by relayer policy
 * and by the "manual broadcast" fallback to show errors before sending). */
export async function simulateExecuteSigned(
  client: PublicClient,
  wallet: Hex,
  op: QWalletOp,
  sig: QSig,
): Promise<SimulationResult> {
  const data = encodeFunctionData({
    abi: quantumWalletAbi,
    functionName: "executeSigned",
    args: encodeSigAndOpArgs(op, sig),
  });
  try {
    const gasEstimate = await client.estimateGas({ account: wallet, to: wallet, data });
    return { ok: true, gasEstimate };
  } catch (e) {
    return { ok: false, gasEstimate: null, revert: decodeRevert(e) };
  }
}

/** Decode a thrown error from a viem call into an ERC-1271-style message. */
export function decodeRevert(e: unknown): string {
  const err = e as { data?: { data?: Hex } | Hex; cause?: { data?: { data?: Hex } | Hex } };
  const raw =
    (typeof err?.data === "object" && err.data ? (err.data as { data?: Hex }).data : undefined) ??
    (typeof err?.data === "string" ? (err.data as Hex) : undefined) ??
    (typeof err?.cause === "object" && err.cause
      ? (err.cause as { data?: { data?: Hex } | Hex }).data
        ? ((err.cause as { data: { data: Hex } }).data.data as Hex)
        : ((err.cause as { data?: Hex }).data as Hex)
      : undefined);
  if (!raw || raw === "0x") {
    return e instanceof Error ? e.message : String(e);
  }
  const named = decodeRevertData(raw);
  if (named) return named;
  return e instanceof Error ? e.message : String(e);
}

/// Both ABIs, because a relay travels through the hub: the outer revert belongs
/// to QuantumRelayHub and the inner one to QuantumWallet.
const REVERT_ABI = [...quantumWalletAbi, ...quantumRelayHubAbi] as const;

/// Name a raw revert payload, or null if nothing in either ABI matches.
export function decodeRevertData(raw: Hex): string | null {
  let decoded;
  try {
    decoded = decodeErrorResult({ abi: REVERT_ABI, data: raw });
  } catch {
    return null;
  }
  const args = decoded.args ?? [];

  // `OpFailed(bytes)` carries the wallet's own revert inside it. Unwrapping
  // matters operationally: a relayer node has to tell "BadNonce — someone else
  // landed this, drop it" apart from "CallFailed — the op itself is broken", and
  // the difference is invisible while the reason is still a hex blob.
  if (decoded.errorName === "OpFailed" && typeof args[0] === "string" && args[0] !== "0x") {
    const inner = decodeRevertData(args[0] as Hex);
    return `OpFailed(${inner ?? args[0]})`;
  }

  return `${decoded.errorName}(${args.map((a) => String(a)).join(", ")})`;
}
