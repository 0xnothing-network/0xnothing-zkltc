import { encodeFunctionData, type Hex } from "viem";
import { publicClient, walletClientFor } from "../rpc/client";
import type { RelayOutcome } from "./client";
import { QUANTUM_CHAIN_ID, QUANTUM_FACTORY } from "./config";
import { quantumWalletFactoryAbi } from "../../../../../quantum-wallet/sdk/src/abi.ts";
import {
  fromWireOp,
  fromWireSig,
  type WireOp,
  type WireSig,
} from "../../../../../quantum-wallet/sdk/src/encode.ts";
import {
  executeSignedCalldata,
  manualBroadcast,
  rotateCalldata,
  signMessageCalldata,
  type ExecuteCalldata,
} from "../../../../../quantum-wallet/sdk/src/relay.ts";

/**
 * Broadcast an already-signed 0xQuantum intent from the user's own HD account,
 * bypassing the sponsor relayer entirely.
 *
 * WHY THIS EXISTS: `executeSigned` never reads `msg.sender`. The signature binds
 * the wallet, the chain, the nonce and every call, so who submits the
 * transaction is irrelevant to its validity — the relayer is a convenience that
 * pays gas, not an authority. Without this path a relayer that is down, rate
 * limiting, or simply unwilling leaves a signed intent stranded forever, because
 * the one thing the wallet may never do is re-sign it onto a fresh leaf.
 *
 * The cost of using it is that the user pays this transaction's gas themselves.
 * That is the whole trade: a wallet that cannot be censored, in exchange for
 * occasionally funding its own escape.
 *
 * THE BYTES ARE NOT RE-DERIVED. Everything here decodes `QuantumPending.request`
 * — the exact payload written to disk before the signature ever left the device —
 * and re-encodes it as calldata. No signing primitive is reachable from this
 * module, by design.
 */

/** Decimal-string guard; wire values are JSON-safe strings, never numbers. */
function isDecimal(value: unknown): value is string {
  return typeof value === "string" && /^\d+$/u.test(value);
}

function isHex32(value: unknown): value is Hex {
  return typeof value === "string" && /^0x[0-9a-fA-F]{64}$/u.test(value);
}

function isAddressHex(value: unknown): value is Hex {
  return typeof value === "string" && /^0x[0-9a-fA-F]{40}$/u.test(value);
}

function isWireSig(value: unknown): value is WireSig {
  if (value === null || typeof value !== "object") return false;
  const sig = value as Record<string, unknown>;
  if (!Number.isInteger(sig.epoch) || !Number.isInteger(sig.leafIndex)) return false;
  if (!Array.isArray(sig.wots) || !Array.isArray(sig.path)) return false;
  return sig.wots.every(isHex32) && sig.path.every(isHex32);
}

function isWireOp(value: unknown): value is WireOp {
  if (value === null || typeof value !== "object") return false;
  const op = value as Record<string, unknown>;
  if (!isDecimal(op.walletNonce) || !isDecimal(op.validUntil)) return false;
  if (!Array.isArray(op.calls)) return false;
  return op.calls.every((call) => {
    if (call === null || typeof call !== "object") return false;
    const c = call as Record<string, unknown>;
    return isAddressHex(c.to) && isDecimal(c.value) && typeof c.data === "string";
  });
}

/**
 * Turn a stored wire request into the transaction to send.
 *
 * `storage.ts` keeps `request` deliberately opaque because the relayer
 * re-validates and re-simulates it in full. This module is the one place that
 * does NOT have that backstop — it builds calldata and hands it to the user's
 * own funded account — so it validates the shape itself rather than trusting
 * the disk. A record that fails these checks is a bug or tampering, and the
 * honest outcome is a clear refusal, not a malformed broadcast.
 *
 * Exported because the relayer node (relayNode.ts) needs exactly the same
 * refusal: it builds calldata from intents fetched off a REMOTE bulletin board,
 * which is even less trustworthy than local disk. Sharing one validator is what
 * keeps the two paths from drifting into different notions of a valid intent.
 */
export function walletCalldataFor(request: unknown): { tx: ExecuteCalldata } | { error: string } {
  if (request === null || typeof request !== "object") {
    return { error: "stored intent is not an object" };
  }
  const req = request as Record<string, unknown>;

  // A request signed for another chain must never be replayed here. The op
  // digest commits to the chain id, so it would revert anyway — but it would
  // revert after the user had already paid for the attempt.
  if (req.chainId !== QUANTUM_CHAIN_ID) {
    return { error: `intent is for chain ${String(req.chainId)}, wallet is on ${QUANTUM_CHAIN_ID}` };
  }
  if (!isAddressHex(req.wallet)) return { error: "intent has no wallet address" };

  if (req.kind === "deploy") {
    if (!isHex32(req.root0)) return { error: "deploy intent has no root0" };
    return {
      tx: {
        to: QUANTUM_FACTORY,
        data: encodeFunctionData({
          abi: quantumWalletFactoryAbi,
          functionName: "deployWallet",
          args: [req.root0],
        }),
      },
    };
  }

  if (!isWireSig(req.sig)) return { error: "intent has no usable signature" };
  const sig = fromWireSig(req.sig);

  if (req.kind === "execute") {
    if (!isWireOp(req.op)) return { error: "execute intent has no usable op" };
    return { tx: executeSignedCalldata(req.wallet, fromWireOp(req.op), sig) };
  }

  if (req.kind === "rotate") {
    if (!isHex32(req.newRoot)) return { error: "rotate intent has no newRoot" };
    if (!Number.isInteger(req.nextEpoch)) return { error: "rotate intent has no nextEpoch" };
    return { tx: rotateCalldata(req.wallet, req.newRoot, req.nextEpoch as number, sig) };
  }

  // signMessage is a real on-chain transaction (it consumes a leaf and records
  // the hash for EIP-1271), so it can be stranded exactly like an execute. It
  // belongs here for the same reason the others do: the relayer accepts the kind
  // (`server.ts:229`) and the board admits it (`board.ts:318`), so leaving it out
  // means an intent that can be posted but that nobody — not the user, not a
  // relayer node — is able to broadcast.
  if (req.kind === "signMessage") {
    if (!isHex32(req.messageHash)) return { error: "signMessage intent has no messageHash" };
    return { tx: signMessageCalldata(req.wallet, req.messageHash, sig) };
  }

  return { error: `cannot self-broadcast intent of kind ${String(req.kind)}` };
}

/**
 * Send the pending intent from `from`, an unlocked HD account in this wallet.
 *
 * Simulates first (inside `manualBroadcast`), so an intent the chain would
 * reject costs the user nothing and returns a decoded revert reason instead.
 */
export async function selfRelay(request: unknown, from: Hex): Promise<RelayOutcome> {
  const built = walletCalldataFor(request);
  if ("error" in built) return { ok: false, error: built.error };
  let walletClient;
  try {
    walletClient = await walletClientFor(from);
  } catch (cause) {
    return { ok: false, error: `cannot sign from ${from}: ${(cause as Error).message}` };
  }
  return manualBroadcast(publicClient, walletClient, built.tx);
}
