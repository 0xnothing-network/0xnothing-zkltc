// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {TestBase} from "../TestBase.sol";
import {DIAOracleAdapter} from "../../src/nusd/DIAOracleAdapter.sol";
import {MockDIAFeed} from "../mocks/MockDIAFeed.sol";

contract DIAOracleAdapterTest is TestBase {
    MockDIAFeed private feed;
    DIAOracleAdapter private adapter;

    function setUp() public {
        vm.warp(1_000_000);
        feed = new MockDIAFeed(8);
        feed.setRound(7, 47_12500000, block.timestamp - 1 minutes, 7);
        adapter = new DIAOracleAdapter(address(feed), 90 minutes);
    }

    function testNormalizesAndReturnsFreshPrice() public view {
        (uint256 price, uint256 updatedAt, uint80 roundId) = adapter.readPriceWad();
        assertEq(price, 47_125000000000000000, "normalized price");
        assertEq(updatedAt, block.timestamp - 1 minutes, "updated at");
        assertEq(uint256(roundId), 7, "round");
    }

    function testRejectsStalePrice() public {
        feed.setRound(8, 47_12500000, block.timestamp - 91 minutes, 8);
        vm.expectRevert();
        adapter.readPriceWad();
    }

    function testRejectsNegativeAndIncompleteRounds() public {
        feed.setRound(9, -1, block.timestamp, 9);
        vm.expectRevert(DIAOracleAdapter.InvalidOracleAnswer.selector);
        adapter.readPriceWad();

        feed.setRound(10, 47_12500000, block.timestamp, 9);
        vm.expectRevert(DIAOracleAdapter.IncompleteOracleRound.selector);
        adapter.readPriceWad();
    }

    function testRejectsFutureTimestamp() public {
        feed.setRound(11, 47_12500000, block.timestamp + 1, 11);
        vm.expectRevert(DIAOracleAdapter.FutureOracleTimestamp.selector);
        adapter.readPriceWad();
    }
}
