// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { NusdNftMarketplace } from "../src/0xpixel/NusdNftMarketplace.sol";

interface VmNusdMarketplaceDeploy {
    function envAddress(string calldata key) external returns (address value);
    function startBroadcast() external;
    function stopBroadcast() external;
}

contract DeployNusdMarketplace {
    error WrongChain();

    VmNusdMarketplaceDeploy private constant vm = VmNusdMarketplaceDeploy(address(uint160(uint256(keccak256("hevm cheat code")))));
    address public constant NUSD = 0x677D63c78E77E0b1971530e1494Caee4Bd7d631e;
    address public constant PIXEL_V1 = 0x33A32b9b2BEe864f9e42BFa39cA7BDC72f655988;
    address public constant PIXEL_V2 = 0xd83cb7aCEF921f98b6B983cBB712a583869Da9eB;
    uint16 public constant PLATFORM_FEE_BPS = 40;

    function run() external returns (NusdNftMarketplace marketplace) {
        if (block.chainid != 4441) revert WrongChain();
        address owner = vm.envAddress("PIXEL_NUSD_MARKET_OWNER");
        address treasury = vm.envAddress("PIXEL_NUSD_MARKET_TREASURY");
        address[] memory collections = new address[](2);
        collections[0] = PIXEL_V1;
        collections[1] = PIXEL_V2;
        vm.startBroadcast();
        marketplace = new NusdNftMarketplace(NUSD, owner, treasury, PLATFORM_FEE_BPS, collections);
        vm.stopBroadcast();
    }
}
