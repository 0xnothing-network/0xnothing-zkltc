// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// Deploy the QuantumWalletFactory to the configured chain and record the
// resulting address + deploy tx to deployments/<chainid>.json for the relayer
// (QW_FACTORY) and the SDK (default factory when none is passed).
//
//   forge script script/DeployFactory.s.sol:DeployFactory \
//       --rpc-url <RPC> --broadcast --private-key $PRIVATE_KEY --slow
//
// $PRIVATE_KEY may be sourced from quantum-wallet/.env.local (see README).
// After broadcast the script writes ./deployments/<chainId>.json
// (fs_permissions allows read-write on ./deployments).

import { ScriptBase } from "./ScriptBase.sol";
import { QuantumWalletFactory } from "../src/QuantumWalletFactory.sol";

contract DeployFactory is ScriptBase {
    function run() external {
        uint256 chainId = vm.envOr("QW_CHAIN_ID", uint256(block.chainid));
        // Read the key ONCE and broadcast with it directly (uint form). Signing
        // from the raw private key means no --private-key CLI flag is needed, so
        // the secret stays in the env only — never in process args or logs. The
        // deployer address is still derived for the deployments record.
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(pk);

        vm.startBroadcast(pk);
        QuantumWalletFactory factory = new QuantumWalletFactory();
        vm.stopBroadcast();

        _record(
            chainId,
            "QuantumWalletFactory",
            address(factory),
            deployer,
            block.number
        );
    }
}
