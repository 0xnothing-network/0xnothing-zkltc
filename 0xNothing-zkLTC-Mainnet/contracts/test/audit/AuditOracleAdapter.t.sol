// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {TestBase} from "../TestBase.sol";
import {OracleNUSDv2} from "../../src/nusd/OracleNUSDv2.sol";
import {DIAOracleAdapter} from "../../src/oracle/DIAOracleAdapter.sol";
import {IPriceOracle} from "../../src/oracle/IPriceOracle.sol";
import {MockDIAFeed} from "../mocks/MockDIAFeed.sol";

/// Tests for the change the static analysis of 2026-11 led to in the price adapter
/// (docs/AUDIT_2026-11.md, section 9.6, S-01). The feeder stamps a round with its own clock. A
/// stamp even one second ahead of the timestamp of the block made every read revert, so minting,
/// redemption (which is never meant to be blocked) and the failure probe all stopped until the
/// chain caught up. A round up to MAX_FUTURE_SKEW ahead is now read as fresh as of now.
contract AuditOracleAdapterTest is TestBase {
    address private constant ALICE = address(0xA11CE);

    MockDIAFeed private feed;
    DIAOracleAdapter private adapter;
    OracleNUSDv2 private nusd;

    function setUp() public {
        vm.warp(1_000_000);
        feed = new MockDIAFeed(8);
        feed.setRound(1, 80e8, 1_000_000, 1);
        adapter = new DIAOracleAdapter(address(feed), "Mock LTC/USD", 1 hours, 1e18, 1000e18);
        nusd = new OracleNUSDv2(IPriceOracle(address(adapter)), address(this), 1_000_000 ether);
        vm.deal(ALICE, 10 ether);
    }

    function testAudit_S01_aRoundStampedAFewSecondsAheadIsReadAsFresh() public {
        vm.prank(ALICE);
        uint256 minted = nusd.mintAtOracle{value: 1 ether}(0, ALICE);
        assertEq(minted, 80 ether, "1 zkLTC at $80");

        feed.setRound(2, 80e8, 1_000_005, 2); // the clock of the feeder is five seconds ahead
        (uint256 price, uint256 updatedAt,) = adapter.readPriceWad();
        assertEq(price, 80 ether, "the price is read");
        assertEq(updatedAt, 1_000_000, "as fresh as of now, never from the future");
        assertTrue(adapter.isFresh(), "fresh");

        // As reviewed, both of these reverted FutureOracleTimestamp until the chain caught up.
        vm.prank(ALICE);
        assertEq(nusd.redeemAtOracle(40 ether, 0, ALICE), 0.5 ether, "redemption is not blocked");
        vm.prank(ALICE);
        assertEq(nusd.mintAtOracle{value: 1 ether}(0, ALICE), 80 ether, "nor is minting");
    }

    function testAudit_S01_aRoundFurtherAheadIsStillRejected() public {
        feed.setRound(2, 80e8, 1_000_060, 2);
        (, uint256 updatedAt,) = adapter.readPriceWad();
        assertEq(updatedAt, 1_000_000, "sixty seconds ahead is the limit and is still read");

        feed.setRound(3, 80e8, 1_000_061, 3);
        vm.expectRevert(DIAOracleAdapter.FutureOracleTimestamp.selector);
        adapter.readPriceWad();
        assertFalse(adapter.isFresh(), "not fresh");
    }

    function testAudit_S01_theAgeLimitIsUnchanged() public {
        vm.warp(1_000_000 + 1 hours);
        (, uint256 updatedAt,) = adapter.readPriceWad();
        assertEq(updatedAt, 1_000_000, "exactly at the age limit: read, with its own timestamp");

        vm.warp(1_000_000 + 1 hours + 1);
        vm.expectRevert(
            abi.encodeWithSelector(DIAOracleAdapter.StaleOraclePrice.selector, 1_000_000, 1_000_000 + 1 hours + 1)
        );
        adapter.readPriceWad();
    }
}
