// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IQuantumWallet} from "../../src/interfaces/IQuantumWallet.sol";

/// Hostile target used to prove the wallet's nonReentrant guard: when the wallet
/// executes a call into this contract, `go()` immediately tries to re-enter the
/// wallet with a freshly-supplied (attacker-crafted) op+signature. If the guard
/// is missing, a valid-looking second op could be double-consumed; with the guard
/// the re-entry reverts and the whole outer op rolls back.
contract ReenterProbe {
    IQuantumWallet private _wallet;
    IQuantumWallet.WalletOp private _op;
    IQuantumWallet.Sig private _sig;

    event Reentered();

    function arm(
        address wallet,
        IQuantumWallet.WalletOp calldata op,
        IQuantumWallet.Sig calldata sig
    ) external {
        _wallet = IQuantumWallet(payable(wallet));
        _op = op;
        _sig = sig;
    }

    function go() external {
        // Called FROM the wallet during executeSigned -> re-entrancy attempt.
        emit Reentered();
        _wallet.executeSigned(_op, _sig);
    }
}
