// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IQuantumWallet} from "./interfaces/IQuantumWallet.sol";
import {HashSig} from "./libs/HashSig.sol";
import {ReentrancyGuard} from "./common/ReentrancyGuard.sol";

/// @title QuantumWallet — post-quantum, gas-sponsorable, address-stable wallet.
/// @dev Each wallet is a FULL, independent contract deployed via CREATE2 (not a
/// proxy) — see DESIGN §6.1 amendment. There is no admin, no upgrade path, and
/// ownership is a hash-based signing tree, not an ECDSA key.
///
/// Security posture (mirrors docs/02-THREAT-MODEL.md):
///  - Assets live at this contract address, which does NOT depend on any signing
///    key, so rotating keys never moves assets (quantum-resistant account model).
///  - Authority = Winternitz signatures over keccak256. No Shor-recoverable math
///    anywhere on the authority path.
///  - One-time leaves consumed strictly in order (single-writer model), so a leaf
///    can never be double-spent across two digests.
///  - `nonReentrant` before any external call; all state advances happen before
///    the calls, and a failed call reverts the whole op.
///
/// The relayer calls the external functions and pays gas; it can only deliver a
/// signed op, never alter it (any byte change invalidates the WOTS digest).
contract QuantumWallet is IQuantumWallet, ReentrancyGuard {
    // --- State (§6.2) -------------------------------------------------------
    uint256 private _nonce; // replay protection for WalletOp
    uint32 private _epoch; // current signing tree epoch
    bytes32 private _merkleRoot; // root of the current epoch tree (a WOTS pubkey commit)
    uint32 private _leafIndex; // next leaf that may be consumed
    address private immutable _factory; // deploying factory
    // EIP-1271 registrations: epoch => digest hash => consuming leaf index+1 (0 = none).
    // Stored +1 so a registration at leaf 0 is still detectable: _signed[..][..] == 0
    // must mean "never registered". See signMessage.
    mapping(uint32 => mapping(bytes32 => uint32)) private _signed;

    // --- Domain separation for digests --------------------------------------
    bytes4 private constant _ERC1271_MAGIC = 0x1626ba7e;
    uint8 private constant _M_SIGNATURE = 0x00; // reserved (future multi-sig)
    uint32 internal constant EPOCH_ZERO = 0;
    /// The final leaf of every epoch tree is reserved for rotateRoot: an epoch
    /// with only its last leaf left can still rotate away (rotating consumes one
    /// leaf), so an owner who exhausts the operational leaves is never bricked.
    uint32 internal constant RESERVED_ROTATE_LEAVES = 1;

    modifier onlyFactory() {
        if (msg.sender != _factory) revert Unauthorized();
        _;
    }

    constructor(bytes32 root0, address factory_) {
        if (root0 == bytes32(0)) revert UnknownRoot();
        _merkleRoot = root0;
        _factory = factory_;
        // epoch 0, leafIndex 0
    }

    receive() external payable {}

    // --- View helpers ---------------------------------------------------------

    function nonce() external view returns (uint256) {
        return _nonce;
    }

    function epoch() external view returns (uint32) {
        return _epoch;
    }

    function merkleRoot() external view returns (bytes32) {
        return _merkleRoot;
    }

    function leafIndex() external view returns (uint32) {
        return _leafIndex;
    }

    function factory() external view returns (address) {
        return _factory;
    }

    /// @dev public (not external) so internal callers can dispatch by bare name —
    /// external functions can only be called via `this.f()` from inside.
    function domainSeparator() public view override returns (bytes32) {
        return keccak256(abi.encodePacked("0xQ-zkLTC-wallet-v1", uint256(block.chainid), address(this)));
    }

    /// @dev Internal digest helper: every signed message is prefixed exactly like
    /// EIP-191/712 personal-message style, but the "domain" binds the wallet
    /// address + chain so a signature can never be replayed against another
    /// wallet or another chain.
    function _digest(bytes32 inner) internal view returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator(), inner));
    }

    function _callsHash(Call[] calldata calls) internal pure returns (bytes32) {
        bytes32[] memory hashes = new bytes32[](calls.length);
        for (uint256 i = 0; i < calls.length; ++i) {
            hashes[i] = keccak256(
                abi.encodePacked(uint8(0xCC), calls[i].to, calls[i].value, calls[i].data.length, calls[i].data)
            );
        }
        return keccak256(abi.encodePacked(hashes));
    }

    function opDigest(WalletOp calldata op) public view override returns (bytes32) {
        return _digest(
            keccak256(abi.encodePacked("WalletOp", uint8(_M_SIGNATURE), op.walletNonce, op.validUntil, _callsHash(op.calls)))
        );
    }

    function rotateDigest(bytes32 newRoot, uint32 nextEpoch) public view override returns (bytes32) {
        return _digest(keccak256(abi.encodePacked("RotateRoot", uint8(_M_SIGNATURE), newRoot, nextEpoch)));
    }

    function messageDigest(bytes32 messageHash) public view override returns (bytes32) {
        return _digest(keccak256(abi.encodePacked("SignMessage", uint8(_M_SIGNATURE), messageHash)));
    }

    /// @dev Core verification. Consumes the next sequential leaf and returns the
    /// committed digest — but only if the leaf opens a path to the current root.
    /// MUST be called after nonce/deadline pre-checks and BEFORE any state change
    /// that depends on it; reverts leave all state untouched.
    function _consumeLeaf(uint256 digest, Sig calldata sig) internal {
        if (sig.epoch != _epoch) revert BadEpoch(sig.epoch, _epoch);
        if (sig.leafIndex != _leafIndex) revert BadLeafIndex(sig.leafIndex, _leafIndex);
        if (_leafIndex >= uint32(HashSig.TREE_N)) revert TreeExhausted();
        bytes32 leaf = HashSig.leafFromSignature(bytes32(digest), sig.wots);
        bytes32 root = HashSig.computeRoot(leaf, uint256(sig.leafIndex), sig.path);
        if (root != _merkleRoot) revert Unauthorized();
        _leafIndex += 1;
    }

    // --- Owner operations ------------------------------------------------------

    function executeSigned(WalletOp calldata op, Sig calldata sig) external nonReentrant {
        if (_leafIndex >= uint32(HashSig.TREE_N) - RESERVED_ROTATE_LEAVES) revert TreeExhausted();
        if (op.walletNonce != _nonce) revert BadNonce(op.walletNonce, _nonce);
        if (op.validUntil < block.timestamp) revert Expired(op.validUntil, block.timestamp);

        bytes32 digest = opDigest(op);
        _consumeLeaf(uint256(digest), sig);

        // Commit to the new nonce BEFORE making external calls. If a call later
        // reverts, the whole tx reverts (state rolls back) — no partial batch.
        _nonce += 1;

        _executeCalls(op.calls);
        emit Executed(op.walletNonce);
    }

    function rotateRoot(bytes32 newRoot, uint32 nextEpoch, Sig calldata sig) external nonReentrant {
        if (newRoot == bytes32(0)) revert UnknownRoot();
        if (nextEpoch != _epoch + 1) revert InvalidRotateEpoch(nextEpoch, _epoch);

        bytes32 digest = rotateDigest(newRoot, nextEpoch);
        _consumeLeaf(uint256(digest), sig);

        // Rotate forward: old epoch leaves can never authorize anything again.
        _epoch = nextEpoch;
        _merkleRoot = newRoot;
        _leafIndex = 0;
        emit RootRotated(nextEpoch, newRoot);
    }

    function signMessage(bytes32 messageHash, Sig calldata sig) external nonReentrant {
        if (_leafIndex >= uint32(HashSig.TREE_N) - RESERVED_ROTATE_LEAVES) revert TreeExhausted();
        bytes32 digest = messageDigest(messageHash);
        _consumeLeaf(uint256(digest), sig);
        // Uniqueness of digest keyed under this epoch: same message signed twice
        // within one epoch would need two leaves but only one mapping slot — the
        // second overwrite is harmless (both were authentic), the first record is
        // what any verifier sees. Distinct messages always differ in the mapping.
        // Store leafIndex+1 so leaf 0 registrations are not mistaken for absent.
        _signed[_epoch][messageHash] = sig.leafIndex + 1;
        emit MessageSigned(messageHash, sig.leafIndex);
    }

    // --- EIP-1271 -------------------------------------------------------------

    function isValidSignature(bytes32 hash, bytes calldata /*signature*/ )
        external
        view
        returns (bytes4)
    {
        // Message was registered by an authenticated op in the CURRENT epoch.
        if (_signed[_epoch][hash] != 0) return _ERC1271_MAGIC;
        return 0xffffffff;
    }

    // --- Internal ----------------------------------------------------------------

    function _executeCalls(Call[] calldata calls) internal {
        for (uint256 i = 0; i < calls.length; ++i) {
            Call calldata c = calls[i];
            (bool ok, bytes memory ret) = c.to.call{value: c.value}(c.data);
            if (!ok) revert CallFailed(i, ret);
        }
    }
}
