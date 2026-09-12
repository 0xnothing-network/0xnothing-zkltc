// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {QuantumRelayHub} from "../../src/QuantumRelayHub.sol";

/// Relayer that tries to re-enter the hub from inside its own gas refund.
///
/// The hub pays with `msg.sender.call{value: amount}("")`, which hands control to
/// the relayer — with almost all the gas — while the hub is still inside `relay`
/// / `relayDeploy`. `receive()` below uses that window to start a second
/// sponsored operation. `nonReentrant` must make the attempt fail.
///
/// The probe swallows that failure instead of bubbling it, which is exactly what a
/// real attacker would do: a reverting `receive()` makes the hub's refund call
/// return false, the hub reverts `RefundFailed`, and the whole attempt disappears.
/// Swallowing keeps the outer call successful so the test can observe that the
/// re-entry was attempted AND refused.
contract RelayReenterProbe {
    QuantumRelayHub public immutable hub;

    bool public reentered;
    bool public reentrySucceeded;

    constructor(QuantumRelayHub hub_) {
        hub = hub_;
    }

    function fireDeploy(bytes32 root0) external returns (address) {
        return hub.relayDeploy(root0);
    }

    function fireRelay(address wallet, bytes calldata data) external {
        hub.relay(wallet, data);
    }

    receive() external payable {
        if (reentered) return;
        reentered = true;
        // Both entry points share one `nonReentrant` slot, so re-entering the
        // cheaper one is a sufficient probe for either.
        try hub.relayDeploy(keccak256("reenter-second-root")) returns (address) {
            reentrySucceeded = true;
        } catch {
            reentrySucceeded = false;
        }
    }
}
