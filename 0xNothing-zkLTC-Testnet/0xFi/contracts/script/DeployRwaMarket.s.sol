// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Script, console2 } from "../lib/openzeppelin-contracts/lib/forge-std/src/Script.sol";
import { RwaMarket } from "../src/rwa/RwaMarket.sol";
import { RwaPriceOracle } from "../src/rwa/RwaPriceOracle.sol";

/// @notice No default asset/feed addresses, no auto-funding or auto-opening.
contract DeployRwaMarket is Script {
    function run() external returns (RwaMarket market) {
        require(block.chainid == 4441 || block.chainid == 31_337, "Unsupported deployment chain");
        address[4] memory sources = [
            vm.envAddress("RWA_ASSET_PRIMARY"),
            vm.envAddress("RWA_ASSET_SECONDARY"),
            vm.envAddress("RWA_SETTLEMENT_PRIMARY"),
            vm.envAddress("RWA_SETTLEMENT_SECONDARY")
        ];
        uint256 age = vm.envUint("RWA_MAX_PRICE_AGE");
        uint256 deviation = vm.envUint("RWA_MAX_DEVIATION_BPS");
        // Dry-run checks must pass before a transaction is queued for broadcast.
        RwaPriceOracle probe = new RwaPriceOracle(sources, age, deviation);
        probe.readPriceWad();
        address owner = vm.envAddress("RWA_OWNER");
        address asset = vm.envAddress("RWA_ASSET");
        address settlement = vm.envAddress("RWA_SETTLEMENT");
        uint256 floor = vm.envUint("RWA_RESERVE_FLOOR");
        uint256 tradeLimit = vm.envUint("RWA_MAX_TRADE_VALUE");
        uint256 sellLimit = vm.envUint("RWA_DAILY_SELL_LIMIT");
        vm.startBroadcast();
        market = new RwaMarket(owner, asset, settlement, sources, age, deviation, floor, tradeLimit, sellLimit);
        vm.stopBroadcast();
        console2.log("RWA market (paused)", address(market));
        console2.log("RWA cross-rate oracle", address(market.oracle()));
    }
}
