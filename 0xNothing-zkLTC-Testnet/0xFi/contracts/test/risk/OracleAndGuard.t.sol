// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { DIAOracleV2Adapter } from "../../src/oracle/DIAOracleV2Adapter.sol";
import { TestBase } from "../TestBase.sol";
import { MockDIAAggregatorV3 } from "./RiskMocks.sol";

contract OracleAdapterTest is TestBase {
    MockDIAAggregatorV3 private feed;
    DIAOracleV2Adapter private adapter;

    function setUp() public {
        vm.warp(1_000_000);
        feed = new MockDIAAggregatorV3(8, "BTC/USD Oracle");
        feed.setRound(10, 100_000e8, block.timestamp, 10);
        adapter = new DIAOracleV2Adapter(address(feed), "BTC/USD Oracle", 90 minutes, 1000 ether, 1_000_000 ether);
    }

    function testNormalizesAssetSpecificFeedAndPinsKey() public view {
        (uint256 priceWad, uint256 updatedAt, uint80 roundId) = adapter.readPriceWad();
        assertEq(priceWad, 100_000 ether, "normalized price");
        assertEq(updatedAt, block.timestamp, "timestamp");
        assertEq(uint256(roundId), 10, "round");
        assertEq(adapter.feedKeyHash(), keccak256(bytes("BTC/USD Oracle")), "feed key");
    }

    function testRejectsWrongKeyStaleRoundAndBounds() public {
        vm.expectRevert(DIAOracleV2Adapter.InvalidFeedKey.selector);
        new DIAOracleV2Adapter(address(feed), "ETH/USD Oracle", 90 minutes, 1 ether, 1_000_000 ether);

        feed.setRound(11, 100_000e8, block.timestamp - 90 minutes - 1, 11);
        vm.expectRevert();
        adapter.readPriceWad();

        feed.setRound(12, 2_000_000e8, block.timestamp, 12);
        vm.expectRevert();
        adapter.readPriceWad();
    }
}
