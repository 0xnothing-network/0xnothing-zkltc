// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IQuantumWallet — ABI-facing surface of the post-quantum contract wallet.
/// @notice Ownership is not an ECDSA key: every state-changing call carries a
/// Winternitz one-time signature (see libs/HashSig.sol) that opens a Merkle leaf
/// belonging to the current epoch root. Leaves are consumed strictly in order, so
/// each op is unique and one-time keys are never reused.
///
/// Structs are declared here so both the wallet and callers/tests/SDK share one
/// ABI. `wots`/`path` are dynamic for a clean ABI; the contract enforces the
/// exact lengths (LEN = 67, TREE_H = 10).
interface IQuantumWallet {
    /// One inner transfer/contract call authored by the wallet owner.
    struct Call {
        address to;
        uint256 value;
        bytes data;
    }

    /// A batch of calls, replay-protected by an explicit per-wallet nonce and a
    /// validity deadline (UNIX seconds). The relayer merely delivers this to the
    /// chain and pays gas; it cannot alter it, because altering changes the digest
    /// the signature commits to.
    struct WalletOp {
        uint256 walletNonce; // MUST equal the wallet's current nonce
        uint256 validUntil; // block.timestamp deadline (op is dead after this)
        Call[] calls;
    }

    /// Post-quantum one-time signature over a digest.
    ///   epoch     — which Merkle tree (root) this leaf belongs to
    ///   leafIndex — position of the leaf in that tree; must advance strictly in order
    ///   wots      — 67 chain elements (LEN), one per message/checksum nibble
    ///   path      — 10 sibling hashes (TREE_H) proving leaf -> root
    struct Sig {
        uint32 epoch;
        uint32 leafIndex;
        bytes32[] wots;
        bytes32[] path;
    }

    event Executed(uint256 indexed nonce);
    event RootRotated(uint32 indexed newEpoch, bytes32 newRoot);
    event MessageSigned(bytes32 indexed hash, uint32 leafIndex);

    error Unauthorized();
    error BadNonce(uint256 got, uint256 want);
    error Expired(uint256 deadline, uint256 now_);
    error BadEpoch(uint32 got, uint32 want);
    error BadLeafIndex(uint32 got, uint32 want);
    error UnknownRoot();
    error TreeExhausted();
    error InvalidRotateEpoch(uint32 nextEpoch, uint32 currentEpoch);
    error CallFailed(uint256 index, bytes reason);

    /// Executes `op` on behalf of the owner. `sig` must open the next sequential
    /// leaf of the current epoch over the op digest.
    function executeSigned(WalletOp calldata op, Sig calldata sig) external;

    /// Rotates the signing tree to `newRoot` for `nextEpoch` (must be epoch+1).
    /// Consumes one leaf of the OLD tree as the authorization, then resets the
    /// leaf counter for the new epoch. Wallet address is unchanged — this is the
    /// key-rotation primitive that makes the account quantum-resistant over time.
    /// The final leaf of every epoch tree is reserved for this call: executeSigned
    /// and signMessage refuse to consume it, so a wallet can always rotate away
    /// instead of being bricked at tree exhaustion.
    function rotateRoot(bytes32 newRoot, uint32 nextEpoch, Sig calldata sig) external;

    /// EIP-1271 support. Because WOTS leaves are one-time and `isValidSignature`
    /// is a stateless view, a message must first be *registered* by an
    /// authenticated op (`signMessage`), which records the hash + epoch leaf. The
    /// stored record is only honored while it belongs to the current epoch.
    function signMessage(bytes32 messageHash, Sig calldata sig) external;

    /// EIP-1271: returns the magic value if `hash` was registered in the current
    /// epoch, per `signMessage`.
    function isValidSignature(bytes32 hash, bytes calldata signature)
        external
        view
        returns (bytes4);

    function nonce() external view returns (uint256);
    function epoch() external view returns (uint32);
    function merkleRoot() external view returns (bytes32);
    function leafIndex() external view returns (uint32);
    function factory() external view returns (address);

    /// EIP-712-style digest bound to this wallet + chain. Exposed so the SDK and
    /// relayer can reproduce exactly what must be signed, and for tests.
    function domainSeparator() external view returns (bytes32);
    function opDigest(WalletOp calldata op) external view returns (bytes32);
    function rotateDigest(bytes32 newRoot, uint32 nextEpoch) external view returns (bytes32);
    function messageDigest(bytes32 messageHash) external view returns (bytes32);

    /// Receives native tokens so a wallet can be funded counterfactually.
    receive() external payable;
}
