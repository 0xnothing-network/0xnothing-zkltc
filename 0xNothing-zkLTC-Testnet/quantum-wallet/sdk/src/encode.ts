// SPDX-License-Identifier: MIT
// Shared wire + ABI-argument types. Hex-encoded everywhere so values survive JSON
// (the sponsor relayer round-trip) and viem tuple encoding with zero ambiguity.

import type { Hex } from "viem";

/** One inner call the wallet executes. */
export interface QCall {
  to: Hex;
  value: bigint;
  /** calldata passed to `to` (empty = plain transfer). */
  data: Hex;
}

/** Signed batch-of-calls intent (digest = opDigest(op)). */
export interface QWalletOp {
  walletNonce: bigint;
  validUntil: bigint;
  calls: QCall[];
}

/** Post-quantum one-time signature over an op digest. */
export interface QSig {
  epoch: number;
  leafIndex: number;
  wots: Hex[];
  path: Hex[];
}

export interface WalletSnapshot {
  wallet: Hex;
  factory: Hex;
  chainId: number;
  state: {
    deployed: boolean;
    nonce: bigint;
    epoch: number;
    merkleRoot: Hex;
    leafIndex: number;
  };
}

/** Convert to ABI-tuple arg shape viem expects for executeSigned. */
export function encodeSigAndOpArgs(
  op: QWalletOp,
  sig: QSig,
): [
  { walletNonce: bigint; validUntil: bigint; calls: QCall[] },
  { epoch: number; leafIndex: number; wots: Hex[]; path: Hex[] },
] {
  return [op, sig];
}

/** JSON-safe wire form (bigint -> decimal string). */
export interface WireOp {
  walletNonce: string;
  validUntil: string;
  calls: { to: Hex; value: string; data: Hex }[];
}

export interface WireSig {
  epoch: number;
  leafIndex: number;
  wots: Hex[];
  path: Hex[];
}

export function toWireOp(op: QWalletOp): WireOp {
  return {
    walletNonce: op.walletNonce.toString(),
    validUntil: op.validUntil.toString(),
    calls: op.calls.map((c) => ({ to: c.to, value: c.value.toString(), data: c.data })),
  };
}

export function toWireSig(sig: QSig): WireSig {
  return { epoch: sig.epoch, leafIndex: sig.leafIndex, wots: sig.wots, path: sig.path };
}

export function fromWireOp(w: WireOp): QWalletOp {
  return {
    walletNonce: BigInt(w.walletNonce),
    validUntil: BigInt(w.validUntil),
    calls: w.calls.map((c) => ({ to: c.to, value: BigInt(c.value), data: c.data })),
  };
}

export function fromWireSig(w: WireSig): QSig {
  return { epoch: w.epoch, leafIndex: w.leafIndex, wots: w.wots, path: w.path };
}
