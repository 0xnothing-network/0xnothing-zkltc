// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { WzkLTC } from "../src/amm/WzkLTC.sol";

interface VmDeployWzkLTC {
    function envUint(string calldata key) external returns (uint256 value);
    function startBroadcast(uint256 privateKey) external;
    function stopBroadcast() external;
}

/// @notice Only for a mainnet with no canonical wrapped zkLTC: deploys the permissionless wrapper
///         the testnet uses. Put the printed address in MAINNET_WZKLTC before the core deploy.
contract DeployWzkLTC {
    error WrongChain(uint256 expectedChainId, uint256 actualChainId);

    VmDeployWzkLTC private constant vm = VmDeployWzkLTC(address(uint160(uint256(keccak256("hevm cheat code")))));

    function run() external returns (WzkLTC wrapped) {
        uint256 expectedChainId = vm.envUint("MAINNET_CHAIN_ID");
        if (expectedChainId == 4441 || block.chainid != expectedChainId) {
            revert WrongChain(expectedChainId, block.chainid);
        }
        vm.startBroadcast(vm.envUint("PRIVATE_KEY"));
        wrapped = new WzkLTC();
        vm.stopBroadcast();
    }
}
