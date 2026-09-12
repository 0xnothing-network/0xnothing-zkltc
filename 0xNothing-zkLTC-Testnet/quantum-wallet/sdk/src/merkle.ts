// SPDX-License-Identifier: MIT
// Merkle tree over WOTS leaves. Building and path/root math mirror
// QuantumWallet + HashSig.computeRoot:
//   node = keccak256( left || right )
//   auth path order: sibling at the leaf level first, root-ward last.

import { TREE_H, TREE_N } from "./constants.ts";
import { cat, keccak } from "./crypto.ts";
import type { Bytes } from "./crypto.ts";

export interface MerkleLevels {
  /** levels[0] = leaves ... levels[H] = [root]. */
  levels: Bytes[][];
  root: Bytes;
}

/** Build all levels from a full ordered list of leaves. */
export function buildLevels(leaves: Bytes[]): MerkleLevels {
  if (leaves.length !== TREE_N) throw new Error(`need ${TREE_N} leaves, got ${leaves.length}`);
  const levels: Bytes[][] = [leaves];
  let cur = leaves;
  while (cur.length > 1) {
    const next: Bytes[] = [];
    for (let i = 0; i < cur.length; i += 2) {
      // cur.length is always even above the root, so both slots exist.
      next.push(keccak(cat(cur[i]!, cur[i + 1]!)));
    }
    levels.push(next);
    cur = next;
  }
  return { levels, root: cur[0]! };
}

/** Auth path for leaf `index` given built levels (level[0] = sibling of leaf). */
export function authPath(levels: Bytes[][], index: number): Bytes[] {
  const path: Bytes[] = [];
  for (let level = 0; level < TREE_H; level++) {
    const nodeIndex = index >> level;
    path.push(levels[level]![nodeIndex ^ 1]!);
  }
  return path;
}

/** Verify (leaf, index, path) recomputes to the expected root. Mirror of
 * HashSig.computeRoot: exact order matters — even nodes concat (self, sibling),
 * odd nodes concat (sibling, self). */
export function computeRoot(leaf: Bytes, index: number, path: Bytes[]): Bytes {
  if (path.length !== TREE_H) throw new Error(`path must have ${TREE_H} elements`);
  let root = leaf;
  for (let level = 0; level < TREE_H; level++) {
    const sibling = path[level]!;
    if (((index >> level) & 1) === 0) {
      root = keccak(cat(root, sibling));
    } else {
      root = keccak(cat(sibling, root));
    }
  }
  return root;
}
