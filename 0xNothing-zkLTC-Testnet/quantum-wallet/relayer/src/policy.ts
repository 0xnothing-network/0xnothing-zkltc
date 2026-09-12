// SPDX-License-Identifier: MIT
// Pure relay policy — no I/O, unit-testable. The server applies this before any
// broadcast; nothing here can spend sponsor funds.

import { isAddress, isHex } from "viem";
import type { RelayRequest } from "../../sdk/src/relay.ts";
// Value import of a pure constant (the SDK module graph has no top-level side
// effects). Importing it rather than re-declaring 0xffffffff here is what keeps
// the client's sentinel and this policy's exception from ever drifting apart —
// the failure mode of drift is total: see the note at the validUntil check.
import { OP_NO_EXPIRY } from "../../sdk/src/wallet.ts";
// Aliased: this module declares its own LEN/TREE_H above (the policy stays
// dependency-light on purpose), so only the leaf-budget constants come from the
// SDK — the same values the client and the contract use.
import {
  EXECUTE_LEAF_LIMIT as SDK_EXECUTE_LEAF_LIMIT,
  TREE_N as SDK_TREE_N,
} from "../../sdk/src/constants.ts";

export const LEN = 67; // WOTS chains per signature (must equal HashSig.LEN)
export const TREE_H = 10; // auth path length (must equal HashSig.TREE_H)

export type PolicyError = string;

/** Structural validation independent of the chain. Returns an error string or null. */
export function validateRequest(
  req: unknown,
  cfg: { chainId: number; maxCallsPerOp: number; maxCalldataBytesPerOp: number; validUntilMaxSkewSec: number },
): PolicyError | null {
  if (typeof req !== "object" || req === null) return "request must be an object";
  const r = req as Partial<RelayRequest>;
  if (!["deploy", "execute", "rotate", "signMessage"].includes(r.kind as string)) {
    return `unknown kind: ${String(r.kind)}`;
  }
  if (!isAddress(r.wallet as string)) return "wallet: bad address";
  if (!Number.isInteger(r.chainId) || Number(r.chainId) !== cfg.chainId) {
    return `chainId mismatch: want ${cfg.chainId}, got ${String(r.chainId)}`;
  }

  if (r.kind === "deploy") {
    if (!isHex(r.root0 as string, { strict: true }) || (r.root0 as string).length !== 66) {
      return "root0: expected 32-byte hex";
    }
    return null;
  }

  // execute / rotate / signMessage all carry a signature.
  const sig = (r as { sig?: { epoch?: unknown; leafIndex?: unknown; wots?: unknown; path?: unknown } }).sig;
  if (!sig || typeof sig !== "object") return "sig: missing";
  if (!Number.isInteger(sig.epoch) || Number(sig.epoch) < 0) return "sig.epoch: bad";
  if (!Number.isInteger(sig.leafIndex) || Number(sig.leafIndex) < 0) return "sig.leafIndex: bad";
  // The contract reserves the final leaf of every tree for rotateRoot: an
  // execute (or signMessage) at that index reverts TreeExhausted unconditionally,
  // so broadcasting it can only burn sponsor gas. rotateRoot has no such bound,
  // which is exactly why one leaf is held back.
  const leafLimit = r.kind === "rotate" ? SDK_TREE_N : SDK_EXECUTE_LEAF_LIMIT;
  if (Number(sig.leafIndex) >= leafLimit) {
    return `sig.leafIndex: ${String(sig.leafIndex)} beyond this tree's limit (${leafLimit})`;
  }
  if (!Array.isArray(sig.wots) || sig.wots.length !== LEN) return `sig.wots: need ${LEN} elements`;
  if (!Array.isArray(sig.path) || sig.path.length !== TREE_H) return `sig.path: need ${TREE_H} elements`;
  for (const w of sig.wots) {
    if (!isHex(w as string, { strict: true }) || (w as string).length !== 66) return "sig.wots: non-bytes32 element";
  }
  for (const p of sig.path) {
    if (!isHex(p as string, { strict: true }) || (p as string).length !== 66) return "sig.path: non-bytes32 element";
  }

  if (r.kind === "rotate") {
    const rot = r as { newRoot?: unknown; nextEpoch?: unknown };
    if (!isHex(rot.newRoot as string, { strict: true }) || (rot.newRoot as string).length !== 66) {
      return "newRoot: expected 32-byte hex";
    }
    if (!Number.isInteger(rot.nextEpoch) || Number(rot.nextEpoch) < 0) return "nextEpoch: bad";
    return null;
  }

  if (r.kind === "signMessage") {
    const sm = r as { messageHash?: unknown };
    if (!isHex(sm.messageHash as string, { strict: true }) || (sm.messageHash as string).length !== 66) {
      return "messageHash: expected 32-byte hex";
    }
    return null;
  }

  // execute: cap the batch.
  const op = (r as { op?: { calls?: unknown; validUntil?: unknown; walletNonce?: unknown } }).op;
  if (!op || typeof op !== "object") return "op: missing";
  if (typeof op.walletNonce !== "string" || !/^\d+$/.test(op.walletNonce)) {
    return "op.walletNonce: decimal string expected";
  }
  if (!Array.isArray(op.calls) || op.calls.length === 0 || op.calls.length > cfg.maxCallsPerOp) {
    return `op.calls: need 1..${cfg.maxCallsPerOp} calls`;
  }
  let calldataBytes = 0;
  for (const c of op.calls as { to?: unknown; value?: unknown; data?: unknown }[]) {
    if (!isAddress(c.to as string)) return "op.calls[].to: bad address";
    if (typeof c.value !== "string" || !/^\d+$/.test(c.value)) return "op.calls[].value: decimal string expected";
    if (!isHex(c.data as string)) return "op.calls[].data: hex expected";
    calldataBytes += ((c.data as string).length - 2) / 2;
  }
  if (calldataBytes > cfg.maxCalldataBytesPerOp) return `op: calldata too large (${calldataBytes} bytes)`;
  if (typeof op.validUntil !== "string" || !/^\d+$/.test(op.validUntil)) return "op.validUntil: decimal string expected";
  // OP_NO_EXPIRY must be accepted, or NOTHING can be relayed. QuantumAccount
  // stamps every sponsored op with it by default, and the mismatch is total
  // rather than partial: the op digest commits to validUntil, so a client cannot
  // "just use a nearer deadline" without re-signing — and re-signing the same
  // leaf is exactly the one-time reuse the scheme forbids. Rejecting the
  // sentinel therefore does not fail one request, it bricks the send path.
  //
  // The skew window below still applies to every *other* deadline, so a buggy or
  // hostile client cannot smuggle an arbitrary far-future value through by
  // disguising it as a normal one. Only the sanctioned sentinel is exempt.
  const validUntil = Number(op.validUntil);
  if (!Number.isSafeInteger(validUntil)) return "op.validUntil: out of range";
  if (validUntil !== Number(OP_NO_EXPIRY)) {
    const skew = validUntil - Math.floor(Date.now() / 1000);
    if (skew > cfg.validUntilMaxSkewSec) return `op.validUntil: more than ${cfg.validUntilMaxSkewSec}s in the future`;
    if (skew < -86_400) return "op.validUntil: expired";
  }
  return null;
}
