// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title HashSig — post-quantum hash-based signatures on the EVM
/// @notice Winternitz one-time signatures (WOTS) over keccak256, committed under a
/// Merkle tree. Verification uses keccak256 only — no ecrecover, no secp256k1 —
/// so a cryptographically-relevant quantum computer cannot recover signing keys
/// (only Grover, which halves preimage security: 256-bit digest => ~128-bit).
///
/// Every signature consumes exactly one leaf of the tree. Leaves are strictly
/// one-time: reusing a leaf for two different digests leaks its secrets, so the
/// wallet consumes leaves in strictly sequential order (see QuantumWallet).
///
/// All parameters MUST stay in lock-step with `sdk/src/wots.ts` (byte-for-byte).
///
///   W_BITS    = 4            digits are nibbles of the 256-bit digest
///   RADIX     = 16           possible digit values (0..15)
///   PUB_STEPS = 15           hashes from secret to public per chain
///   LEN1      = 64           message digits
///   LEN2      = 3            checksum digits (ceil(log16(64*15+1)))
///   LEN       = 67           total chains per signature
///   TREE_H    = 10           tree height => 1024 one-time keys per epoch
///   TREE_N    = 1024
///
/// Canonical test vector generation lives in `sdk/test/vectors.gen.ts`; the
/// output JSON is consumed by `test/unit/HashSigVectors.t.sol` so Solidity and
/// the TypeScript SDK are proven to agree.
library HashSig {
    uint256 internal constant W_BITS = 4;
    uint256 internal constant RADIX = 1 << W_BITS; // 16
    uint256 internal constant PUB_STEPS = RADIX - 1; // 15
    uint256 internal constant LEN1 = 256 / W_BITS; // 64
    uint256 internal constant LEN2 = 3; // checksum digits
    uint256 internal constant LEN = LEN1 + LEN2; // 67
    uint256 internal constant TREE_H = 10;
    uint256 internal constant TREE_N = 1 << TREE_H; // 1024

    /// Chain-function domain byte. Prefixing every hash application separates
    /// chains by position so values from one chain can never be replayed in
    /// another (position-domain separation).
    uint8 internal constant DOMAIN = 0x71;

    error WrongSignatureLength(uint256 got, uint256 want);
    error WrongPathLength(uint256 got, uint256 want);
    error InvalidDigit();
    error InvalidChainSteps();

    /// One keccak256 application on chain `j`.
    /// @dev The preimage is `DOMAIN ‖ j ‖ x` (34 bytes), assembled in the EVM's
    /// scratch space rather than with `abi.encodePacked`. That is not a
    /// micro-optimisation: encodePacked bumps the free-memory pointer on every
    /// call and Solidity never frees, so the ~500-1000 chain steps of a single
    /// WOTS verification leak proportional memory, and building a full 1024-leaf
    /// key schedule (~1M steps) leaks ~65 MB — quadratic expansion costing
    /// billions of gas, which OOGs the test signer's constructor. Scratch space
    /// (0x00-0x3f) is guaranteed clobberable under `memory-safe`, so the loop
    /// stays flat. Output is byte-identical to the encodePacked form.
    function chainStep(bytes32 x, uint8 j) internal pure returns (bytes32 out) {
        assembly ("memory-safe") {
            // byte 0 = DOMAIN, byte 1 = j, bytes 2..33 = x
            mstore(0x00, or(shl(248, DOMAIN), shl(240, j)))
            mstore(0x02, x)
            out := keccak256(0x00, 34)
        }
    }

    /// `steps` chain applications (0..PUB_STEPS). Applying a step 0 times is the
    /// identity, which is what makes the public key chain start at the secret.
    function chain(bytes32 x, uint8 j, uint256 steps) internal pure returns (bytes32) {
        if (steps > PUB_STEPS) revert InvalidChainSteps();
        for (uint256 i = 0; i < steps; ++i) x = chainStep(x, j);
        return x;
    }

    /// Public key element for chain `j` (15 applications from the secret).
    function publicElement(bytes32 secret, uint8 j) internal pure returns (bytes32) {
        return chain(secret, j, PUB_STEPS);
    }

    /// Winternitz signature element for digit `d` on chain `j`.
    function signElement(bytes32 secret, uint8 j, uint8 d) internal pure returns (bytes32) {
        if (d >= RADIX) revert InvalidDigit();
        return chain(secret, j, PUB_STEPS - uint256(d));
    }

    /// Nibbles of the digest that the signature commits to (message part).
    function messageDigits(uint256 digest) internal pure returns (uint256[LEN1] memory out) {
        for (uint256 j = 0; j < LEN1; ++j) {
            out[j] = (digest >> (252 - 4 * j)) & 0xF;
        }
    }

    /// WOTS checksum = sum over message digits of (15 - digit), base-16, MSB
    /// first, in LEN2 digits. Binds the message so raising any message digit
    /// forces the checksum to drop and no single chain is ever free.
    function checksumDigits(uint256[LEN1] memory msgDigits) internal pure returns (uint8[LEN2] memory out) {
        uint256 sum;
        for (uint256 j = 0; j < LEN1; ++j) sum += PUB_STEPS - msgDigits[j];
        out[0] = uint8((sum >> 8) & 0xF);
        out[1] = uint8((sum >> 4) & 0xF);
        out[2] = uint8(sum & 0xF);
    }

    /// Recomputes the leaf a valid signature would open, i.e. the commitment
    /// over the candidate public elements derived from `sig` for `digest`.
    /// @dev `memory` (not `calldata`) so both internal calldata callers (the
    /// wallet) and in-memory callers (tests, other libraries) can pass arrays —
    /// calldata -> memory is implicit, memory -> calldata is not.
    function leafFromSignature(bytes32 digest, bytes32[] memory sig)
        internal
        pure
        returns (bytes32 leaf)
    {
        if (sig.length != LEN) revert WrongSignatureLength(sig.length, LEN);

        uint256[LEN1] memory msgDigits = messageDigits(uint256(digest));
        uint8[LEN2] memory checksum = checksumDigits(msgDigits);

        bytes memory buf = new bytes(LEN * 32);
        uint256 ptr;
        assembly ("memory-safe") {
            ptr := add(buf, 0x20)
        }
        for (uint256 j = 0; j < LEN1; ++j) {
            bytes32 candidate = chain(sig[j], uint8(j), msgDigits[j]);
            assembly ("memory-safe") {
                mstore(add(ptr, mul(j, 0x20)), candidate)
            }
        }
        for (uint256 j = 0; j < LEN2; ++j) {
            bytes32 candidate = chain(sig[LEN1 + j], uint8(LEN1 + j), uint256(checksum[j]));
            uint256 dst = LEN1 + j; // hoist: Yul has no '+' operator, constants only inline as literals
            assembly ("memory-safe") {
                mstore(add(ptr, mul(dst, 0x20)), candidate)
            }
        }
        leaf = keccak256(buf);
    }

    /// Walks `leaf` up the Merkle tree using its auth `path` for `leafIndex`.
    /// @dev `memory` for the same reason as leafFromSignature.
    function computeRoot(
        bytes32 leaf,
        uint256 leafIndex,
        bytes32[] memory path
    ) internal pure returns (bytes32 root) {
        if (path.length != TREE_H) revert WrongPathLength(path.length, TREE_H);
        root = leaf;
        for (uint256 level = 0; level < TREE_H; ++level) {
            bytes32 sibling = path[level];
            if (((leafIndex >> level) & 1) == 0) {
                // node is the left child -> concat(node, sibling)
                root = keccak256(abi.encodePacked(root, sibling));
            } else {
                root = keccak256(abi.encodePacked(sibling, root));
            }
        }
    }
}
