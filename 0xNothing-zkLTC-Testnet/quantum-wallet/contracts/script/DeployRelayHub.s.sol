// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// Deploy QuantumRelayHub against the ALREADY-DEPLOYED factory and optionally
// fund its vault in the same run.
//
//   forge script script/DeployRelayHub.s.sol:DeployRelayHub \
//       --rpc-url <RPC> --broadcast --slow
//
// Environment:
//   PRIVATE_KEY   dev key (never passed as a CLI flag — read from env only)
//   QW_FACTORY    the factory already live on this chain
//   QW_HUB_FUND   optional wei to seed the vault with, default 0
//
// ⛔ This script does NOT deploy a factory and must never be made to. The factory
// on LiteForge is live and every wallet address is a CREATE2 prediction from it;
// a second factory would strand every existing wallet. It reads QW_FACTORY and
// fails loudly if that is unset.
//
// The record is written to deployments/<chainId>-relayhub.json — a DIFFERENT file
// from DeployFactory's deployments/<chainId>.json, which must not be overwritten.

import { ScriptBase } from "./ScriptBase.sol";
import { QuantumRelayHub } from "../src/QuantumRelayHub.sol";
import { IQuantumWalletFactory } from "../src/interfaces/IQuantumWalletFactory.sol";

contract DeployRelayHub is ScriptBase {
    error FactoryHasNoCode(address factory);

    function run() external {
        uint256 chainId = vm.envOr("QW_CHAIN_ID", uint256(block.chainid));
        address factory = vm.envAddress("QW_FACTORY");
        uint256 fund = vm.envOr("QW_HUB_FUND", uint256(0));

        // Pointing the hub at an address with no code would produce a contract
        // whose every relayDeploy reverts, and the mistake would only surface
        // after it was deployed and funded.
        if (factory.code.length == 0) revert FactoryHasNoCode(factory);

        uint256 pk = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(pk);

        vm.startBroadcast(pk);
        QuantumRelayHub hub = new QuantumRelayHub(IQuantumWalletFactory(factory), deployer);
        if (fund > 0) {
            (bool ok,) = address(hub).call{ value: fund }("");
            require(ok, "fund failed");
        }
        vm.stopBroadcast();

        _recordAs(
            string.concat("deployments/", vm.toString(chainId), "-relayhub.json"),
            chainId,
            "QuantumRelayHub",
            address(hub),
            deployer,
            block.number
        );
    }
}
