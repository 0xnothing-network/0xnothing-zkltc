// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {TestBase} from "../TestBase.sol";
import {RoleControl} from "../../src/common/RoleControl.sol";
import {SafeTransferLib} from "../../src/common/SafeTransferLib.sol";
import {DIAOracleAdapter} from "../../src/nusd/DIAOracleAdapter.sol";
import {OracleNUSD} from "../../src/nusd/OracleNUSD.sol";
import {MockDIAFeed} from "../mocks/MockDIAFeed.sol";

contract RejectingTreasury {
    // No receive/fallback: native pushes revert.
}

contract OracleNUSDPolicyTest is TestBase {
    MockDIAFeed private feed;
    DIAOracleAdapter private oracle;
    OracleNUSD private nusd;

    address private constant USER = address(0xA11CE);
    address private constant OTHER = address(0xB0B);
    address private constant TREASURY = address(0xFEE);

    function setUp() public {
        vm.warp(1_000_000);
        feed = new MockDIAFeed(18);
        feed.setRound(1, 50 ether, block.timestamp, 1);
        oracle = new DIAOracleAdapter(address(feed), 90 minutes, address(this), 1, type(uint256).max, 0);
        nusd = new OracleNUSD(oracle, address(this), 1_000_000 ether);
        vm.deal(USER, 100 ether);
        vm.deal(OTHER, 100 ether);
    }

    function testPolicyDefaultsAreOff() public view {
        assertEq(nusd.mintFeeBps(), 0, "mint fee");
        assertEq(nusd.redeemFeeBps(), 0, "redeem fee");
        assertEq(nusd.treasury(), address(0), "treasury");
        assertEq(nusd.issuanceCeilingNusd(), 0, "issuance ceiling");
        assertEq(nusd.dailyMintCapNusd(), 0, "daily mint");
        assertEq(nusd.dailyRedeemCapNusd(), 0, "daily redeem");
        assertEq(nusd.perWalletDailyMintCapNusd(), 0, "wallet mint");
        assertEq(nusd.perWalletDailyRedeemCapNusd(), 0, "wallet redeem");
        assertFalse(nusd.sameBlockMintRedeemBlocked(), "same-block guard");
        assertEq(nusd.remainingDailyMintCapNusd(), type(uint256).max, "mint remaining");
        assertEq(nusd.remainingWalletDailyMintCapNusd(USER), type(uint256).max, "wallet remaining");
    }

    function testMintFeeGoesToTreasuryAndKeepsOneToOneBacking() public {
        nusd.setTreasury(TREASURY);
        nusd.setMintFeeBps(100);

        assertEq(nusd.quoteMint(1 ether), 49.5 ether, "quote net of 100 bps");

        vm.prank(USER);
        uint256 minted = nusd.mintAtOracle{value: 1 ether}(49.5 ether, USER);

        assertEq(minted, 49.5 ether, "user mint");
        assertEq(nusd.balanceOf(USER), 49.5 ether, "user balance");
        assertEq(nusd.balanceOf(TREASURY), 0.5 ether, "treasury fee");
        assertEq(nusd.totalSupply(), 50 ether, "gross supply");
        assertEq(nusd.totalCollateralWei(), 1 ether, "full collateral stays");
        assertEq(nusd.reserveValueNusd(), 50 ether, "reserve still 1:1 at oracle");
    }

    function testRedeemFeePaysNativeToTreasury() public {
        nusd.setTreasury(TREASURY);
        nusd.setRedeemFeeBps(100);
        vm.prank(USER);
        nusd.mintAtOracle{value: 1 ether}(50 ether, USER);

        assertEq(nusd.quoteRedeem(10 ether), 0.198 ether, "quote net of 100 bps");
        uint256 treasuryBefore = TREASURY.balance;

        vm.prank(USER);
        uint256 received = nusd.redeemAtOracle(10 ether, 0.198 ether, USER);

        assertEq(received, 0.198 ether, "user collateral");
        assertEq(nusd.pendingTreasuryNative(), 0.002 ether, "fee held for pull");
        assertEq(TREASURY.balance, treasuryBefore, "treasury not pushed");
        assertEq(nusd.totalSupply(), 40 ether, "burned");
        assertEq(nusd.totalCollateralWei(), 0.8 ether, "gross reserve drop");
        assertEq(address(nusd).balance, 0.802 ether, "collateral plus pending fee");

        nusd.withdrawTreasuryFees();
        assertEq(TREASURY.balance, treasuryBefore + 0.002 ether, "treasury pulled");
        assertEq(nusd.pendingTreasuryNative(), 0, "cleared");
        assertEq(address(nusd).balance, 0.8 ether, "native remaining");
    }

    function testFeeSettersAreCappedAndNeedTreasury() public {
        vm.expectRevert(OracleNUSD.TreasuryNotSet.selector);
        nusd.setMintFeeBps(1);
        vm.expectRevert(OracleNUSD.InvalidFee.selector);
        nusd.setMintFeeBps(101);

        nusd.setTreasury(TREASURY);
        nusd.setMintFeeBps(100);
        nusd.setRedeemFeeBps(50);
        vm.expectRevert(OracleNUSD.InvalidTreasury.selector);
        nusd.setTreasury(address(0));
        vm.expectRevert(OracleNUSD.InvalidTreasury.selector);
        nusd.setTreasury(address(nusd));

        nusd.setMintFeeBps(0);
        nusd.setRedeemFeeBps(0);
        nusd.setTreasury(address(0));
        assertEq(nusd.treasury(), address(0), "unset after zero fees");
    }

    function testOnlyAdminCanConfigurePolicy() public {
        vm.startPrank(USER);
        vm.expectRevert(abi.encodeWithSelector(RoleControl.MissingRole.selector, bytes32(0), USER));
        nusd.setTreasury(TREASURY);
        vm.expectRevert(abi.encodeWithSelector(RoleControl.MissingRole.selector, bytes32(0), USER));
        nusd.setDailyMintCapNusd(1 ether);
        vm.expectRevert(abi.encodeWithSelector(RoleControl.MissingRole.selector, bytes32(0), USER));
        nusd.setSameBlockMintRedeemBlocked(true);
        vm.stopPrank();
    }

    function testDailyMintAndRedeemCapsResetNextUtcDay() public {
        nusd.setDailyMintCapNusd(60 ether);
        nusd.setDailyRedeemCapNusd(20 ether);

        vm.prank(USER);
        nusd.mintAtOracle{value: 1 ether}(50 ether, USER);
        vm.prank(USER);
        vm.expectRevert(abi.encodeWithSelector(OracleNUSD.DailyMintCapExceeded.selector, 50 ether, 10 ether));
        nusd.mintAtOracle{value: 1 ether}(0, USER);

        vm.prank(USER);
        nusd.transfer(OTHER, 21 ether);
        vm.prank(OTHER);
        nusd.redeemAtOracle(20 ether, 0, OTHER);
        vm.prank(OTHER);
        vm.expectRevert(abi.encodeWithSelector(OracleNUSD.DailyRedeemCapExceeded.selector, 1 ether, 0));
        nusd.redeemAtOracle(1 ether, 0, OTHER);

        vm.warp(((block.timestamp / 1 days) + 1) * 1 days);
        feed.setRound(2, 50 ether, block.timestamp, 2);
        vm.prank(USER);
        nusd.mintAtOracle{value: 1 ether}(50 ether, USER);
        vm.prank(USER);
        nusd.transfer(OTHER, 21 ether);
        vm.prank(OTHER);
        nusd.redeemAtOracle(20 ether, 0, OTHER);
        assertEq(nusd.dailyMintedNusd(), 50 ether, "new mint day");
        assertEq(nusd.dailyRedeemedNusd(), 20 ether, "new redeem day");
    }

    function testPerWalletDailyCapsAreIsolated() public {
        nusd.setPerWalletDailyMintCapNusd(50 ether);
        nusd.setPerWalletDailyRedeemCapNusd(10 ether);

        vm.prank(USER);
        nusd.mintAtOracle{value: 1 ether}(50 ether, USER);
        vm.prank(USER);
        vm.expectRevert();
        nusd.mintAtOracle{value: 1 ether}(0, USER);

        vm.prank(OTHER);
        nusd.mintAtOracle{value: 1 ether}(50 ether, OTHER);
        assertEq(nusd.balanceOf(OTHER), 50 ether, "other wallet has its own cap");

        vm.prank(USER);
        nusd.redeemAtOracle(10 ether, 0, USER);
        vm.prank(USER);
        vm.expectRevert();
        nusd.redeemAtOracle(1, 0, USER);
        vm.prank(OTHER);
        nusd.redeemAtOracle(10 ether, 0, OTHER);
    }

    function testMintToRecipientConsumesRecipientWalletMintCap() public {
        nusd.setPerWalletDailyMintCapNusd(50 ether);
        vm.prank(USER);
        nusd.mintAtOracle{value: 1 ether}(50 ether, OTHER);
        vm.prank(OTHER);
        vm.expectRevert();
        nusd.mintAtOracle{value: 1 ether}(0, OTHER);
    }

    function testAdminIssuanceCeilingIsOptionalAndTighterThanConstructor() public {
        nusd.setIssuanceCeilingNusd(50 ether);
        vm.prank(USER);
        nusd.mintAtOracle{value: 1 ether}(50 ether, USER);
        vm.prank(USER);
        vm.expectRevert();
        nusd.mintAtOracle{value: 1}(0, USER);

        nusd.setIssuanceCeilingNusd(0);
        vm.prank(USER);
        nusd.mintAtOracle{value: 1 ether}(50 ether, USER);
        assertEq(nusd.totalSupply(), 100 ether, "disabled ceiling");
    }

    function testSameBlockMintRedeemGuardDefaultsOffAndCanBeArmed() public {
        vm.prank(USER);
        nusd.mintAtOracle{value: 1 ether}(50 ether, USER);
        vm.prank(USER);
        nusd.redeemAtOracle(10 ether, 0, USER);

        nusd.setSameBlockMintRedeemBlocked(true);
        vm.roll(1_000);
        vm.prank(USER);
        nusd.mintAtOracle{value: 1 ether}(50 ether, USER);
        vm.prank(USER);
        vm.expectRevert(OracleNUSD.SameBlockMintRedeem.selector);
        nusd.redeemAtOracle(10 ether, 0, USER);

        vm.roll(1_001);
        vm.prank(USER);
        uint256 out = nusd.redeemAtOracle(10 ether, 0, USER);
        assertGt(out, 0, "next block redeem");

        vm.prank(USER);
        vm.expectRevert(OracleNUSD.SameBlockMintRedeem.selector);
        nusd.mintAtOracle{value: 1 ether}(50 ether, USER);

        vm.roll(1_002);
        vm.prank(USER);
        uint256 minted = nusd.mintAtOracle{value: 1 ether}(50 ether, USER);
        assertEq(minted, 50 ether, "mint after redeem in a new block");
    }

    function testZeroFeeQuotesMatchLegacyOneToOneModel() public {
        assertEq(nusd.quoteMint(1 ether), 50 ether, "mint 1:1");
        assertEq(nusd.quoteRedeem(50 ether), 1 ether, "redeem 1:1");
    }

    function testDailyRedeemCapIgnoresSameWalletMintRedeemCycle() public {
        nusd.setDailyRedeemCapNusd(20 ether);

        vm.prank(USER);
        nusd.mintAtOracle{value: 1 ether}(50 ether, USER);
        vm.prank(USER);
        nusd.redeemAtOracle(50 ether, 0, USER);
        assertEq(nusd.dailyRedeemedNusd(), 0, "cycle excluded from global redeem");

        vm.prank(OTHER);
        nusd.mintAtOracle{value: 1 ether}(50 ether, OTHER);
        vm.warp(((block.timestamp / 1 days) + 1) * 1 days);
        feed.setRound(2, 50 ether, block.timestamp, 2);

        vm.prank(USER);
        nusd.mintAtOracle{value: 1 ether}(50 ether, USER);
        vm.prank(USER);
        nusd.redeemAtOracle(40 ether, 0, USER);
        assertEq(nusd.dailyRedeemedNusd(), 0, "same-day mint still excluded");

        vm.prank(OTHER);
        nusd.redeemAtOracle(20 ether, 0, OTHER);
        vm.prank(OTHER);
        vm.expectRevert(abi.encodeWithSelector(OracleNUSD.DailyRedeemCapExceeded.selector, 1 ether, 0));
        nusd.redeemAtOracle(1 ether, 0, OTHER);
    }

    function testDailyCapsRejectDustMinimum() public {
        vm.expectRevert(OracleNUSD.InvalidDailyCap.selector);
        nusd.setDailyMintCapNusd(1);
        vm.expectRevert(OracleNUSD.InvalidDailyCap.selector);
        nusd.setDailyRedeemCapNusd(1 ether - 1);
        vm.expectRevert(OracleNUSD.InvalidDailyCap.selector);
        nusd.setPerWalletDailyMintCapNusd(1);
        vm.expectRevert(OracleNUSD.InvalidDailyCap.selector);
        nusd.setPerWalletDailyRedeemCapNusd(1);

        nusd.setDailyMintCapNusd(1 ether);
        nusd.setDailyRedeemCapNusd(0);
        nusd.setPerWalletDailyMintCapNusd(1 ether);
        nusd.setPerWalletDailyRedeemCapNusd(0);
        assertEq(nusd.dailyMintCapNusd(), 1 ether, "min mint cap");
        assertEq(nusd.dailyRedeemCapNusd(), 0, "zero still unlimited");
    }

    function testSameBlockGuardKeysOnMinterNotRecipient() public {
        nusd.setSameBlockMintRedeemBlocked(true);
        vm.roll(2_000);
        vm.prank(OTHER);
        nusd.mintAtOracle{value: 1 ether}(50 ether, OTHER);

        vm.roll(2_001);
        vm.prank(USER);
        nusd.mintAtOracle{value: 1 ether}(50 ether, OTHER);
        vm.prank(OTHER);
        uint256 out = nusd.redeemAtOracle(10 ether, 0, OTHER);
        assertGt(out, 0, "dust mint to victim does not grief redeem");

        vm.prank(USER);
        nusd.mintAtOracle{value: 1 ether}(50 ether, USER);
        vm.prank(USER);
        vm.expectRevert(OracleNUSD.SameBlockMintRedeem.selector);
        nusd.redeemAtOracle(10 ether, 0, USER);
    }

    function testRejectingTreasuryCannotBrickRedeem() public {
        RejectingTreasury rejecting = new RejectingTreasury();
        nusd.setTreasury(address(rejecting));
        nusd.setRedeemFeeBps(100);
        vm.prank(USER);
        nusd.mintAtOracle{value: 1 ether}(50 ether, USER);

        vm.prank(USER);
        uint256 received = nusd.redeemAtOracle(10 ether, 0, USER);
        assertEq(received, 0.198 ether, "redeem paid user");
        assertEq(nusd.pendingTreasuryNative(), 0.002 ether, "fee queued");

        vm.expectRevert(SafeTransferLib.NativeTransferFailed.selector);
        nusd.withdrawTreasuryFees();

        nusd.setTreasury(TREASURY);
        nusd.withdrawTreasuryFees();
        assertEq(TREASURY.balance, 0.002 ether, "retargeted pull");
        assertEq(nusd.pendingTreasuryNative(), 0, "cleared after pull");
    }
}
