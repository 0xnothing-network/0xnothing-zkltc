// SPDX-License-Identifier: MIT
// One Merkle-Winternitz signer = one epoch tree derived from a 32-byte seed.
// The public root is what gets committed to a QuantumWallet; signatures are
// produced for strictly increasing leaf indices (mirroring the wallet's
// sequential-consumption rule). Building the 1024-leaf tree is the expensive
// part (~1M keccak) and happens lazily once per signer.

import { LEN, TREE_H, TREE_N } from "./constants.ts";
import type { Bytes } from "./crypto.ts";
import { authPath, buildLevels } from "./merkle.ts";
import type { MerkleLevels } from "./merkle.ts";
import { leafSecret, publicLeaf, signElement, digitsOf } from "./wots.ts";

export interface WotsSignature {
  /** 67 chain elements covering the digest digits. */
  wots: Bytes[];
  /** 10 sibling hashes proving leaf -> root. */
  path: Bytes[];
  /** Leaf index used. */
  leafIndex: number;
  /** The digest that was covered (for convenience). */
  digest: Bytes;
}

export class QuantumSigner {
  readonly seed: Bytes;
  private _levels: MerkleLevels | null = null;
  /** Next leaf that SHOULD be used, per the single-writer model. */
  leafCursor = 0;

  constructor(seed: Bytes) {
    if (seed.length !== 32) throw new Error("seed must be 32 bytes");
    this.seed = seed;
  }

  /** Build/return the tree levels (lazy, memoized). */
  private get tree(): MerkleLevels {
    if (!this._levels) {
      const leaves: Bytes[] = new Array(TREE_N);
      for (let i = 0; i < TREE_N; i++) leaves[i] = publicLeaf(this.seed, i);
      this._levels = buildLevels(leaves);
    }
    return this._levels;
  }

  get root(): Bytes {
    return this.tree.root;
  }

  leafPublic(index: number): Bytes {
    return publicLeaf(this.seed, index);
  }

  /** Sign `digest` at a specific leaf (advanced use / rotate). No reuse check. */
  signAt(digest: Bytes, leafIndex: number): WotsSignature {
    if (leafIndex < 0 || leafIndex >= TREE_N) throw new Error(`leafIndex ${leafIndex} out of range`);
    const digits = digitsOf(digest);
    if (digits.length !== LEN) throw new Error("digits length invariant broken");
    const wots: Bytes[] = [];
    for (let j = 0; j < LEN; j++) {
      wots.push(signElement(leafSecret(this.seed, leafIndex, j), j, digits[j]!));
    }
    return { wots, path: authPath(this.tree.levels, leafIndex), leafIndex, digest };
  }

  /** Sign the next leaf and advance the cursor (single-writer guard). */
  signNext(digest: Bytes): WotsSignature {
    if (this.leafCursor >= TREE_N) {
      throw new Error(`tree exhausted at leaf ${this.leafCursor} — must rotate root`);
    }
    const sig = this.signAt(digest, this.leafCursor);
    this.leafCursor += 1;
    return sig;
  }

  /** Reset the cursor (called after rotating to a fresh epoch/tree). */
  reset() {
    this.leafCursor = 0;
  }

  /** ~90% usage threshold for advising rotation. */
  get needsRotation(): boolean {
    return this.leafCursor >= Math.floor((TREE_N * 9) / 10);
  }
}
