// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IQuantumWallet} from "./IQuantumWallet.sol";

/// @title IQuantumWalletFactory — CREATE2 counterfactual deployment of wallets.
interface IQuantumWalletFactory {
    event WalletDeployed(address indexed wallet, bytes32 root0, address deployer);

    error AlreadyDeployed(address wallet);
    error DeploymentFailed();
    error InitCodeMismatch(address predicted, address deployed);

    /// Deterministic salt for a wallet given its initial root. Bound to this
    /// factory address (CREATE2) and the current chain (salt derivation), so a
    /// wallet address can never collide with one from another chain/factory.
    function saltFor(bytes32 root0) external view returns (bytes32);

    /// Init code hash = keccak(creationCode ++ abi.encode(root0, factory)).
    /// `view` because the creation code embeds `address(this)`.
    function initCodeHash(bytes32 root0) external view returns (bytes32);

    /// Counterfactual address — safe to fund before deployment.
    function predictWallet(bytes32 root0) external view returns (address);

    /// Deploys the wallet (anyone may call; gas is sponsored by the relayer).
    function deployWallet(bytes32 root0) external returns (address wallet);

    function isWallet(address candidate) external view returns (bool);
}
