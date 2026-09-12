// SPDX-License-Identifier: MIT
// High-level account object — what the extension (phase 4) will embed. One
// QuantumAccount = one wallet address (root0) + its current epoch signer.

import { QuantumSigner } from "./signer.ts";
import { treeSeedFromSecret } from "./derive.ts";
import { bytesToHex32, opDigest } from "./digest.ts";
import type { Bytes, Hex } from "./crypto.ts";
import type { QCall, QSig, QWalletOp } from "./encode.ts";

export interface WalletOpInput {
  walletNonce: bigint;
  calls: QCall[];
  /** Unix seconds; defaults to OP_NO_EXPIRY. */
  validUntil?: bigint;
}

/**
 * Deadline stamped on sponsored ops — deliberately far future (Feb 2106), not
 * "now + 10 minutes".
 *
 * executeSigned rejects an expired op BEFORE consuming its leaf, and a leaf can
 * only ever be advanced by a valid signature at exactly that index. So if an op
 * expires unmined, the leaf it was signed for is stuck: re-signing it with a
 * fresh deadline would put a second WOTS signature on one leaf, which is the
 * break the one-time scheme forbids, and skipping to the next leaf reverts
 * BadLeafIndex forever. A short deadline therefore converts any relay outage
 * that outlasts it into a bricked wallet.
 *
 * Nothing is lost by dropping it: replay is already prevented by walletNonce
 * (BadNonce once the op lands) and by the one-time leaf itself, so validUntil
 * carries no security weight on this path. Making it unreachable is what lets a
 * failed send stay retryable indefinitely.
 */
export const OP_NO_EXPIRY = 0xffffffffn;

export class QuantumAccount {
  readonly secret: Bytes;
  readonly signer: QuantumSigner;
  /** Which signing-tree epoch this account signs for. Fresh accounts are epoch 0;
   * after a rotateRoot the successor account is created with epoch = nextEpoch so
   * its signatures match the on-chain epoch (signOp stamps this value). */
  readonly epoch: number;

  private constructor(secret: Bytes, epoch: number, signer: QuantumSigner) {
    this.secret = secret;
    this.epoch = epoch;
    this.signer = signer;
  }

  static fromSecret(secret: Bytes, epoch = 0): QuantumAccount {
    if (!Number.isInteger(epoch) || epoch < 0 || epoch > 0xffffffff) {
      throw new Error(`epoch out of uint32 range: ${epoch}`);
    }
    return new QuantumAccount(secret, epoch, new QuantumSigner(treeSeedFromSecret(secret)));
  }

  get root0(): Bytes {
    return this.signer.root;
  }

  get root0Hex(): Hex {
    return bytesToHex32(this.signer.root);
  }

  /**
   * Align the local leaf cursor with the chain (single-writer model).
   *
   * The chain is authoritative in BOTH directions. `_consumeLeaf` requires
   * sig.leafIndex == _leafIndex exactly, so a cursor left ahead of the chain by
   * a signature that never mined makes every later op revert BadLeafIndex, and
   * a skipped leaf can never be consumed by anything. The old forward-only
   * clamp made exactly that state unrecoverable after a failed relay.
   *
   * Rewinding is safe ONLY because the one-time property is enforced above
   * this: the caller persists every signed intent before it leaves the device
   * and replays those identical bytes rather than re-signing the leaf (see
   * apps/wallet/src/core/quantum/storage.ts). Do not call this without that
   * guard — on its own it would happily re-sign a burned leaf.
   */
  syncLeaf(chainLeafIndex: number) {
    if (!Number.isInteger(chainLeafIndex) || chainLeafIndex < 0) return;
    this.signer.leafCursor = chainLeafIndex;
  }

  signOp(op: QWalletOp, chainId: bigint, wallet: Hex): QSig {
    const digest = opDigest(op, { chainId, wallet });
    const s = this.signer.signNext(digest);
    return {
      epoch: this.epoch, // signing tree this account represents
      leafIndex: s.leafIndex,
      wots: s.wots.map(bytesToHex32),
      path: s.path.map(bytesToHex32),
    };
  }

  /** Build + sign a transfer-like op at the account's current chain nonce. */
  buildExecuteOp(
    chainId: bigint,
    wallet: Hex,
    chainNonce: bigint,
    calls: QCall[],
    validUntil = OP_NO_EXPIRY,
  ): { op: QWalletOp; sig: QSig } {
    const op: QWalletOp = { walletNonce: chainNonce, validUntil, calls };
    return { op, sig: this.signOp(op, chainId, wallet) };
  }
}
