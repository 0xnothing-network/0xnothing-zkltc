// SPDX-License-Identifier: MIT
// Shared constants. MUST match contracts/src/libs/HashSig.sol and QuantumWallet.sol
// byte-for-byte. Any drift here breaks every signature.

export const W_BITS = 4;
export const RADIX = 1 << W_BITS; // 16
export const PUB_STEPS = RADIX - 1; // 15
export const LEN1 = 256 / W_BITS; // 64
export const LEN2 = 3; // checksum digits
export const LEN = LEN1 + LEN2; // 67
export const TREE_H = 10;
export const TREE_N = 1 << TREE_H; // 1024

/**
 * QuantumWallet.RESERVED_ROTATE_LEAVES. The last leaf of every tree is reserved
 * so that a rotation is ALWAYS possible: executeSigned and signMessage revert
 * TreeExhausted at `_leafIndex >= TREE_N - RESERVED_ROTATE_LEAVES`, while
 * rotateRoot has no such check and may consume that final leaf.
 *
 * Clients must mirror this. A client that signs an execute at the reserved leaf
 * burns it on a digest the contract will never accept, and the later rotation —
 * the only way out — would then be a SECOND signature over that same leaf with a
 * different digest, which is precisely the one-time break WOTS forbids.
 */
export const RESERVED_ROTATE_LEAVES = 1;

/** Highest leaf index + 1 that executeSigned / signMessage will accept (1023). */
export const EXECUTE_LEAF_LIMIT = TREE_N - RESERVED_ROTATE_LEAVES;

/// Chain-function domain byte (HashSig.DOMAIN = 0x71).
export const CHAIN_DOMAIN = 0x71;
/// _M_SIGNATURE in QuantumWallet (0x00).
export const M_SIGNATURE = 0x00;
/// Call encoding tag in QuantumWallet._callsHash (0xCC).
export const CALL_TAG = 0xcc;

// Domain strings used in digest construction.
export const DOMAIN_PREFIX = "0xQ-zkLTC-wallet-v1";
export const OP_TAG = "WalletOp";
export const ROTATE_TAG = "RotateRoot";
export const MESSAGE_TAG = "SignMessage";

// EIP-1271 magic value.
export const ERC1271_MAGIC = "0x1626ba7e";

// Hard upper bound a wallet will ever hold (uint32 leaves per epoch).
export const MAX_EPOCH = 0xffffffff;
