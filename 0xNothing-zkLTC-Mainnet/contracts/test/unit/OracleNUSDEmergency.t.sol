// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {TestBase} from "../TestBase.sol";
import {DIAOracleAdapter} from "../../src/nusd/DIAOracleAdapter.sol";
import {OracleNUSD} from "../../src/nusd/OracleNUSD.sol";
import {MockDIAFeed} from "../mocks/MockDIAFeed.sol";

/// The price-free exit must keep holders' collateral reachable when the oracle dies
/// for good, without ever opening while the oracle can still price.
contract OracleNUSDEmergencyTest is TestBase {
    address private constant ALICE = address(0xA11CE);
    address private constant BOB = address(0xB0B);
    MockDIAFeed private feed;
    OracleNUSD private nusd;

    function setUp() public {
        vm.warp(10_000_000);
        feed = new MockDIAFeed(8);
        feed.setRound(1, 100_00000000, block.timestamp, 1); // 1 zkLTC = 100 NUSD
        nusd = new OracleNUSD(new DIAOracleAdapter(address(feed), 90 minutes), address(this), type(uint128).max);
        vm.deal(ALICE, 10 ether);
        vm.deal(BOB, 10 ether);
        vm.prank(ALICE);
        nusd.mintAtOracle{value: 3 ether}(0, ALICE); // 300 NUSD
        vm.prank(BOB);
        nusd.mintAtOracle{value: 1 ether}(0, BOB); // 100 NUSD
    }

    function _killOracle() private {
        feed.setRound(2, 100_00000000, block.timestamp - 2 hours, 2);
    }

    function testExitStaysClosedWhileOracleIsHealthy() public {
        vm.expectRevert(OracleNUSD.OracleHealthy.selector);
        nusd.reportOracleFailure();
        vm.prank(ALICE);
        vm.expectRevert(OracleNUSD.OracleFailureNotReported.selector);
        nusd.emergencyRedeem(1 ether, 0, ALICE);
    }

    function testExitOpensOnlyAfterTheGracePeriod() public {
        _killOracle();
        nusd.reportOracleFailure();
        assertEq(nusd.oracleFailureReportedAt(), block.timestamp, "clock started");
        vm.warp(block.timestamp + 7 days - 1);
        vm.prank(ALICE);
        vm.expectRevert();
        nusd.emergencyRedeem(1 ether, 0, ALICE);
    }

    function testProportionalExitIgnoresPauseAndOrder() public {
        _killOracle();
        nusd.reportOracleFailure();
        nusd.setRedeemPaused(true);
        vm.warp(block.timestamp + 7 days);
        // The normal path is dead; the price-free path still pays.
        vm.prank(BOB);
        vm.expectRevert();
        nusd.redeemAtOracle(100 ether, 0, BOB);

        uint256 bobBefore = BOB.balance;
        vm.prank(BOB);
        uint256 bobOut = nusd.emergencyRedeem(100 ether, 1 ether, BOB);
        assertEq(bobOut, 1 ether, "bob gets his quarter of the reserve");
        assertEq(BOB.balance - bobBefore, 1 ether, "paid natively");

        vm.prank(ALICE);
        uint256 aliceOut = nusd.emergencyRedeem(300 ether, 0, ALICE);
        assertEq(aliceOut, 3 ether, "order of exits does not change shares");
        assertEq(nusd.totalSupply(), 0, "supply fully redeemed");
        assertEq(nusd.totalCollateralWei(), 0, "reserve fully paid out");
    }

    function testRecoveredOracleClosesTheExitAndResetsTheClock() public {
        _killOracle();
        nusd.reportOracleFailure();
        vm.warp(block.timestamp + 8 days);
        feed.setRound(3, 100_00000000, block.timestamp, 3);
        vm.prank(ALICE);
        vm.expectRevert(OracleNUSD.OracleHealthy.selector);
        nusd.emergencyRedeem(1 ether, 0, ALICE);
        nusd.clearOracleFailure();
        assertEq(nusd.oracleFailureReportedAt(), 0, "clock reset");
        // A later failure needs a fresh full grace period.
        _killOracle();
        nusd.reportOracleFailure();
        vm.prank(ALICE);
        vm.expectRevert();
        nusd.emergencyRedeem(1 ether, 0, ALICE);
    }

    function testMinimumOutputAndRecipientAreEnforced() public {
        _killOracle();
        nusd.reportOracleFailure();
        vm.warp(block.timestamp + 7 days);
        vm.prank(BOB);
        vm.expectRevert();
        nusd.emergencyRedeem(100 ether, 1 ether + 1, BOB);
        vm.prank(BOB);
        vm.expectRevert(OracleNUSD.InvalidRecipient.selector);
        nusd.emergencyRedeem(100 ether, 0, address(0));
        vm.prank(BOB);
        vm.expectRevert();
        nusd.emergencyRedeem(101 ether, 0, BOB);
    }
}
