// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {TestBase} from "../TestBase.sol";
import {DIAOracleAdapter} from "../../src/oracle/DIAOracleAdapter.sol";
import {MockDIAFeed} from "../mocks/MockDIAFeed.sol";

contract DIAOracleAdapterTest is TestBase {
    MockDIAFeed private feed;
    DIAOracleAdapter private adapter;

    function setUp() public {
        vm.warp(1_000_000);
        feed = new MockDIAFeed(8);
        feed.setRound(7, 60e8, vm.getBlockTimestamp(), 7);
        adapter = new DIAOracleAdapter(address(feed), "Mock LTC/USD", 90 minutes, 10 ether, 1_000 ether);
    }

    function testNormalizesToWad() public view {
        (uint256 price, uint256 updatedAt, uint80 roundId) = adapter.readPriceWad();
        assertEq(price, 60 ether, "8 decimals to 18");
        assertEq(updatedAt, vm.getBlockTimestamp(), "timestamp");
        assertEq(roundId, 7, "round");
        assertTrue(adapter.isFresh(), "fresh");
    }

    function testStaleIncompleteAndOutOfBoundsPricesFailClosed() public {
        vm.warp(vm.getBlockTimestamp() + 90 minutes + 1);
        assertFalse(adapter.isFresh(), "stale");
        vm.expectRevert();
        adapter.readPriceWad();

        feed.setRound(8, 60e8, vm.getBlockTimestamp(), 7);
        vm.expectRevert(DIAOracleAdapter.IncompleteOracleRound.selector);
        adapter.readPriceWad();

        feed.setRound(9, 5e8, vm.getBlockTimestamp(), 9);
        vm.expectRevert(abi.encodeWithSelector(DIAOracleAdapter.OraclePriceOutOfBounds.selector, 5 ether, 10 ether, 1_000 ether));
        adapter.readPriceWad();
    }

    function testConstructorChecksFeedKeyAgeAndBounds() public {
        vm.expectRevert(DIAOracleAdapter.InvalidFeedKey.selector);
        new DIAOracleAdapter(address(feed), "BTC/USD", 90 minutes, 10 ether, 1_000 ether);
        vm.expectRevert(DIAOracleAdapter.InvalidMaxPriceAge.selector);
        new DIAOracleAdapter(address(feed), "Mock LTC/USD", 1 minutes, 10 ether, 1_000 ether);
        vm.expectRevert(DIAOracleAdapter.InvalidPriceBounds.selector);
        new DIAOracleAdapter(address(feed), "Mock LTC/USD", 90 minutes, 1_000 ether, 10 ether);
        vm.expectRevert(DIAOracleAdapter.InvalidFeed.selector);
        new DIAOracleAdapter(address(0xBEEF), "Mock LTC/USD", 90 minutes, 10 ether, 1_000 ether);
    }
}
