// The 0xQuantum SDK lives beside this repo (quantum-wallet/sdk). Importing it
// directly keeps the extension bit-for-bit aligned with the Solidity wallet —
// re-copying these primitives here would risk drift between signer and contract.
// The SDK is browser-safe (viem + WebCrypto only), so Vite bundles it as-is.

import type { Hex, PublicClient } from "viem";
import { hexBytes, toHex } from "../../../../../quantum-wallet/sdk/src/crypto.ts";
import {
  decodeSecret,
  encodeSecret,
  generateSecret,
  type DecodeResult,
} from "../../../../../quantum-wallet/sdk/src/icons.ts";
// Value import, not `import type`: QuantumAccount is a class and is called as
// one below (QuantumAccount.fromSecret).
import { QuantumAccount } from "../../../../../quantum-wallet/sdk/src/wallet.ts";
import { bytesToHex32, rotateDigest } from "../../../../../quantum-wallet/sdk/src/digest.ts";
import {
  EXECUTE_LEAF_LIMIT,
  TREE_N,
} from "../../../../../quantum-wallet/sdk/src/constants.ts";
import {
  predictWallet,
  readWalletState,
  type WalletState,
} from "../../../../../quantum-wallet/sdk/src/reads.ts";
import {
  toWireOp,
  toWireSig,
  type QCall,
  type QSig,
} from "../../../../../quantum-wallet/sdk/src/encode.ts";
import { relay, type RelayOutcome } from "./client";
import { QUANTUM_CHAIN_ID, QUANTUM_FACTORY } from "./config";
import {
  readQuantum,
  withSignLock,
  writeQuantum,
  writePending,
  type QuantumPending,
  type QuantumStored,
} from "./storage";

export type { DecodeResult };

export interface NewSecret {
  entropy: Uint8Array;
  icons: string;
}

/** Fresh CSPRNG secret + its 24-icon backup string. */
export async function newSecret(): Promise<NewSecret> {
  return generateSecret();
}

/** Deterministic 24-icon backup for a stored secret. */
export function iconsFor(entropy: Uint8Array): Promise<string> {
  return encodeSecret(entropy);
}

/** 0x-hex form of the entropy, for persistence. */
export function entropyHex(entropy: Uint8Array): Hex {
  return toHex(entropy);
}

/** Validate a user-typed 24-icon backup string. */
export async function decodeIcons(icons: string): Promise<DecodeResult> {
  return decodeSecret(icons);
}

/** Predict the CREATE2 address of a fresh (epoch-0) account. */
export async function createQuantum(
  client: PublicClient,
  entropy: Uint8Array,
): Promise<{ account: QuantumAccount; address: Hex }> {
  const account = QuantumAccount.fromSecret(entropy, 0);
  const address = await predictWallet(client, QUANTUM_FACTORY, account.root0Hex);
  return { account, address };
}

/**
 * A persisted intent is actionable only while the chain still sits exactly on
 * the leaf it burned, in the epoch it was signed under. Past either, the bytes
 * have already landed or a rotation retired their tree, and the slot is dead.
 */
export function livePending(
  pending: QuantumPending | null | undefined,
  state: WalletState,
): QuantumPending | null {
  if (!pending) return null;
  if (pending.epoch !== state.epoch) return null;
  if (pending.leafIndex !== state.leafIndex) return null;
  return pending;
}

/** Account for a stored secret at a known epoch (e.g. a parked successor). */
export function accountFromEntropyHex(entropyHex: Hex, epoch: number): QuantumAccount {
  return QuantumAccount.fromSecret(hexBytes(entropyHex), epoch);
}

/**
 * Executes still signable in this tree before a rotation becomes mandatory.
 *
 * The contract reserves the final leaf for rotateRoot, so a tree that looks like
 * it has one leaf left has none for spending. Counting down to zero here (rather
 * than to one) keeps that arithmetic in a single place.
 */
export function executeLeavesLeft(state: WalletState): number {
  return Math.max(0, EXECUTE_LEAF_LIMIT - state.leafIndex);
}

/** True once the only leaf left is the one reserved for rotateRoot. */
export function mustRotate(state: WalletState): boolean {
  return state.leafIndex >= EXECUTE_LEAF_LIMIT;
}

export interface ResumedWallet {
  stored: QuantumStored;
  account: QuantumAccount;
  address: Hex;
  state: WalletState;
  /** Signed bytes still owed to the chain — replay, never re-sign. */
  pending: QuantumPending | null;
}

/**
 * Rebuild the account from storage, finishing whatever was in flight when the
 * popup last closed.
 *
 * Two things can be unfinished. A rotation may have landed after its successor
 * secret was persisted but before the local switch — the chain's epoch says so,
 * and we adopt the successor. Otherwise a signed intent may still be sitting on
 * its leaf, in which case it comes back as `pending` and the caller must replay
 * those exact bytes rather than sign anything new.
 */
export async function resumeQuantum(
  client: PublicClient,
  stored: QuantumStored,
): Promise<ResumedWallet> {
  let record = stored;

  // Building a tree is 1024 leaves of hashing, so derive the address only for
  // legacy records that predate the persisted field. Those are all epoch 0
  // (rotation is precisely what made persistence necessary), so the tree root
  // is the factory salt there and the derivation is correct.
  let address = record.address;
  if (address === undefined) {
    const seed = QuantumAccount.fromSecret(hexBytes(record.entropyHex), record.epoch);
    address = await predictWallet(client, QUANTUM_FACTORY, seed.root0Hex);
  }

  const state = await readWalletState(client, address);

  const inflight = record.pending;
  if (
    inflight?.kind === "rotate" &&
    inflight.successorEntropyHex !== undefined &&
    state.epoch === inflight.epoch + 1
  ) {
    // The rotation confirmed while we were away. Adopt the successor secret the
    // rotate path parked for exactly this case.
    record = {
      entropyHex: inflight.successorEntropyHex,
      epoch: state.epoch,
      address,
      pending: null,
    };
    await writeQuantum(record);
  } else {
    // Persist the address on first sight so a later rotation cannot orphan it,
    // and retire a pending slot the chain has already moved past. These are
    // independent: clearing must NOT piggyback on the address write, or a still
    // -live intent would be dropped and its leaf stranded forever.
    const stale = Boolean(inflight) && livePending(inflight, state) === null;
    if (record.address === undefined || stale) {
      record = stale ? { ...record, address, pending: null } : { ...record, address };
      await writeQuantum(record);
    }
  }

  const account = QuantumAccount.fromSecret(hexBytes(record.entropyHex), record.epoch);
  account.syncLeaf(state.leafIndex);
  return { stored: record, account, address, state, pending: livePending(record.pending, state) };
}

/**
 * Recover an EXISTING wallet from its backup icons plus its address.
 *
 * Rotating hands the user a brand-new secret whose tree root is not the factory
 * salt, so after a rotation the icons alone no longer determine the address —
 * the user supplies it (it is public). The chain says which epoch the tree is
 * at; the secret is accepted only if it reproduces the on-chain root, which
 * proves these icons currently control this wallet.
 */
export async function recoverQuantum(
  client: PublicClient,
  entropy: Uint8Array,
  address: Hex,
): Promise<
  | { ok: true; account: QuantumAccount; address: Hex; state: WalletState }
  | { ok: false; reason: "not-deployed" | "root-mismatch" }
> {
  const state = await readWalletState(client, address);
  if (!state.deployed) return { ok: false, reason: "not-deployed" };
  const account = QuantumAccount.fromSecret(entropy, state.epoch);
  // root0Hex is "this tree's root" — at a non-zero epoch that is the CURRENT
  // signing root, which is exactly what the wallet stores in merkleRoot.
  if (account.root0Hex.toLowerCase() !== state.merkleRoot.toLowerCase()) {
    return { ok: false, reason: "root-mismatch" };
  }
  account.syncLeaf(state.leafIndex);
  return { ok: true, account, address, state };
}

export function activateWire(account: QuantumAccount, address: Hex): unknown {
  return { kind: "deploy", wallet: address, chainId: QUANTUM_CHAIN_ID, root0: account.root0Hex };
}

/** A signed intent plus the leaf it burned. Persist before relaying. */
export interface SignedIntent {
  kind: "execute" | "rotate";
  leafIndex: number;
  epoch: number;
  request: unknown;
}

/** Sign a batch-of-calls op (send, ERC20 transfer, swap) into a relay request. */
export function executeIntent(
  account: QuantumAccount,
  address: Hex,
  nonce: bigint,
  calls: QCall[],
): SignedIntent {
  const { op, sig } = account.buildExecuteOp(BigInt(QUANTUM_CHAIN_ID), address, nonce, calls);
  return {
    kind: "execute",
    leafIndex: sig.leafIndex,
    epoch: sig.epoch,
    request: {
      kind: "execute",
      wallet: address,
      chainId: QUANTUM_CHAIN_ID,
      op: toWireOp(op),
      sig: toWireSig(sig),
    },
  };
}

/**
 * Sign the rotateRoot intent with the CURRENT tree. `successorRoot` is the new
 * tree's root; `nextEpoch` must be current epoch + 1. The account that signs
 * for the successor tree is created by the caller with epoch = nextEpoch.
 */
export function rotateIntent(
  account: QuantumAccount,
  successorRoot: Hex,
  nextEpoch: number,
  address: Hex,
): SignedIntent {
  const digest = rotateDigest(hexBytes(successorRoot), nextEpoch, {
    chainId: BigInt(QUANTUM_CHAIN_ID),
    wallet: address,
  });
  const s = account.signer.signNext(digest);
  const sig: QSig = {
    epoch: account.epoch,
    leafIndex: s.leafIndex,
    wots: s.wots.map(bytesToHex32),
    path: s.path.map(bytesToHex32),
  };
  return {
    kind: "rotate",
    leafIndex: s.leafIndex,
    epoch: account.epoch,
    request: {
      kind: "rotate",
      wallet: address,
      chainId: QUANTUM_CHAIN_ID,
      newRoot: successorRoot,
      nextEpoch,
      sig: toWireSig(sig),
    },
  };
}

export async function relayDeploy(payload: unknown): Promise<RelayOutcome> {
  return relay(payload);
}

/**
 * Re-POST an already-signed request verbatim. The only safe retry: the bytes
 * carry a one-time signature bound to a specific leaf, so re-signing to "fix"
 * a failed send would burn a second signature on that same leaf.
 */
export async function relayIntent(request: unknown): Promise<RelayOutcome> {
  return relay(request);
}

export type LeafClaimReason =
  | "not-deployed"
  | "stale-epoch"
  /** Another context already holds the next leaf. */
  | "busy"
  /** A signature exists for a leaf the chain has not consumed. */
  | "diverged"
  /** No leaf left for this kind of op — the tree must be rotated. */
  | "exhausted";

/** A signing attempt refused because no unused leaf could be claimed. */
export class LeafClaimError extends Error {
  readonly reason: LeafClaimReason;

  constructor(reason: LeafClaimReason) {
    super(`cannot sign: ${reason}`);
    this.name = "LeafClaimError";
    this.reason = reason;
  }
}

/**
 * The ONLY sanctioned way to produce a signature.
 *
 * Signing is a compare-and-swap on a one-time leaf, and every fact the decision
 * rests on — the chain's leaf index, the epoch, whether an intent is already
 * outstanding — can be changed by another extension context between the caller
 * mounting and the caller clicking. So this re-derives all of them from the
 * chain and from disk at the moment of signing, inside a cross-document lock,
 * and ignores whatever the caller had in React state.
 *
 * `build` runs with the freshly-read state and returns the intent to arm; it is
 * the caller's chance to attach e.g. a rotation's successor secret. It must not
 * itself sign anything.
 *
 * `kind` must match what `build` will sign, because the two have different leaf
 * budgets: the contract reserves the last leaf of every tree for rotateRoot.
 */
export async function claimSignedIntent(
  client: PublicClient,
  address: Hex,
  account: QuantumAccount,
  kind: QuantumPending["kind"],
  build: (state: WalletState) => QuantumPending,
): Promise<{ pending: QuantumPending; state: WalletState }> {
  return withSignLock(async () => {
    const state = await readWalletState(client, address);
    if (!state.deployed) throw new LeafClaimError("not-deployed");

    // Signatures carry the epoch, and the contract checks it — but a signature
    // from a retired tree would also be made at a leaf index the successor tree
    // uses for its own, so refuse before the bytes exist rather than let the
    // chain reject them.
    if (state.epoch !== account.epoch) throw new LeafClaimError("stale-epoch");

    // Mirror QuantumWallet.RESERVED_ROTATE_LEAVES. executeSigned reverts at the
    // final leaf while rotateRoot may spend it, and signing an execute there
    // would be worse than a wasted leaf: the bytes can never land, so the only
    // way out is a rotation — which would then be a SECOND signature over that
    // same leaf under a different digest, i.e. a forgeable key. Refuse instead
    // and make the user rotate, which costs them nothing and keeps the address.
    const limit = kind === "rotate" ? TREE_N : EXECUTE_LEAF_LIMIT;
    if (state.leafIndex >= limit) throw new LeafClaimError("exhausted");

    // Someone else signed the next leaf and their bytes are the only ones that
    // may consume it. Ours would be the second signature over that leaf.
    const stored = await readQuantum();
    if (stored?.pending) throw new LeafClaimError("busy");

    if (account.signer.leafCursor > state.leafIndex) {
      // We hold a signature for a leaf the chain has not consumed, but nothing
      // on disk records it — the pending record was lost. Rewinding to re-sign
      // that leaf is exactly the double-signature this guard exists to prevent,
      // so stop instead: the wallet is unusable until it is restored from its
      // icon backup, which is recoverable, unlike a leaked one-time key.
      throw new LeafClaimError("diverged");
    }
    // Behind the chain is the benign case: each of the intervening leaves was
    // consumed by exactly one signature (someone else's), so adopting the
    // chain's index skips only genuinely unused leaves.
    if (account.signer.leafCursor !== state.leafIndex) account.syncLeaf(state.leafIndex);

    const pending = build(state);
    // Persist before the bytes can leave the device — everything downstream
    // assumes the only signature made for this leaf is recoverable from here.
    await writePending(pending);
    return { pending, state };
  });
}
