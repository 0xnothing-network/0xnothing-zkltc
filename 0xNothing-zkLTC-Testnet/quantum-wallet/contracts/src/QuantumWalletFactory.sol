// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IQuantumWallet} from "./interfaces/IQuantumWallet.sol";
import {IQuantumWalletFactory} from "./interfaces/IQuantumWalletFactory.sol";
import {QuantumWallet} from "./QuantumWallet.sol";

/// @title QuantumWalletFactory — CREATE2 deployment of full QuantumWallet contracts.
/// @dev Per DESIGN §6.1 amendment, each wallet is a complete, standalone contract
/// (no EIP-1167 proxy, no delegatecall). The factory is tiny and stateless; its
/// only job is deterministic deployment. Anyone can call deployWallet — on the
/// sponsored flow the relayer is the caller and pays the gas.
contract QuantumWalletFactory is IQuantumWalletFactory {
    bytes32 private constant _NAMESPACE = keccak256("0xQ-salt-v1");
    bytes32 private constant _COMMIT_PREFIX = keccak256("0xQ-commit-v1");

    function saltFor(bytes32 root0) public view returns (bytes32) {
        // commitment binds the canonical init state (root0, epoch0=0); chain binds
        // the address to this deployment so the same secret yields different
        // addresses on different chains.
        bytes32 commitment = keccak256(abi.encodePacked(_COMMIT_PREFIX, root0, uint32(0)));
        return keccak256(abi.encodePacked(_NAMESPACE, uint256(block.chainid), commitment));
    }

    /// @dev `view` (not `pure`): the init code embeds `address(this)` — the wallet
    /// constructor must know its deploying factory, and the creation code is
    /// therefore factory-specific.
    function initCodeHash(bytes32 root0) public view returns (bytes32) {
        return keccak256(abi.encodePacked(type(QuantumWallet).creationCode, abi.encode(root0, address(this))));
    }

    function predictWallet(bytes32 root0) public view returns (address) {
        return address(
            uint160(
                uint256(
                    keccak256(abi.encodePacked(bytes1(0xff), address(this), saltFor(root0), initCodeHash(root0)))
                )
            )
        );
    }

    function deployWallet(bytes32 root0) external returns (address wallet) {
        address predicted = predictWallet(root0);
        if (predicted.code.length != 0) revert AlreadyDeployed(predicted);

        bytes memory initCode = abi.encodePacked(type(QuantumWallet).creationCode, abi.encode(root0, address(this)));
        bytes32 salt = saltFor(root0);
        assembly ("memory-safe") {
            wallet := create2(0, add(initCode, 0x20), mload(initCode), salt)
        }
        if (wallet == address(0)) revert DeploymentFailed();
        if (wallet != predicted) revert InitCodeMismatch(predicted, wallet);

        emit WalletDeployed(wallet, root0, msg.sender);
    }

    function isWallet(address candidate) external view returns (bool) {
        // Reject EOAs and wallets deployed by a different factory. A wallet of
        // ours always reports its factory; we don't store an explicit set, so we
        // verify by asking the candidate. If candidate has no code, this is a
        // clean false (low-level staticcall returns empty).
        uint256 size;
        assembly ("memory-safe") {
            size := extcodesize(candidate)
        }
        if (size == 0) return false;
        (bool ok, bytes memory ret) = candidate.staticcall(abi.encodeWithSelector(IQuantumWallet.factory.selector));
        return ok && ret.length == 32 && abi.decode(ret, (address)) == address(this);
    }
}
