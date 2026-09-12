// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// Hostile contract that impersonates a QuantumWallet to `QuantumWalletFactory.isWallet`.
///
/// `isWallet` staticcalls the candidate's `factory()` and believes the answer, so
/// membership in "our wallets" is SELF-DECLARED. This contract has no tree, no
/// nonce and no signature check, yet it passes that test — and its fallback then
/// burns every gas unit forwarded to it before returning success, so the caller
/// has no failure to detect.
///
/// Those two facts together are why `QuantumRelayHub` keeps its own `sponsored`
/// set, populated from `factory.deployWallet`'s return value, instead of asking
/// `isWallet`. A hub that trusted `isWallet` would reimburse this contract for
/// burning gas, on demand, until the vault was empty.
contract FakeQuantumWallet {
    address private immutable _factory;

    /// Written at the end of the burn loop so the optimizer cannot discard the
    /// work as dead code — the gas has to actually be spent for the probe to mean
    /// anything.
    uint256 public burnt;

    constructor(address factory_) {
        _factory = factory_;
    }

    function factory() external view returns (address) {
        return _factory;
    }

    fallback() external payable {
        uint256 waste = burnt;
        // Leave just enough to finish the SSTORE and return normally.
        while (gasleft() > 25_000) {
            waste = uint256(keccak256(abi.encode(waste)));
        }
        burnt = waste;
    }
}
