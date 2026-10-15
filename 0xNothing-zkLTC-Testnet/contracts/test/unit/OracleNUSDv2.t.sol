// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {TestBase} from "../TestBase.sol";
import {OracleNUSDv2} from "../../src/nusd/OracleNUSDv2.sol";
import {IPriceOracle} from "../../src/oracle/IPriceOracle.sol";
import {MockPriceOracle} from "../mocks/TokenomicsMocks.sol";

contract OracleNUSDv2Test is TestBase {
    uint256 private constant PRICE = 100 ether; // $100 per zkLTC
    uint256 private constant CEILING = 1_000_000 ether;

    address private constant ALICE = address(0xA11CE);
    address private constant BOB = address(0xB0B);
    address private constant STAKING = address(0x57A6);
    address private constant TREASURY = address(0x7EA5);
    address private constant STRANGER = address(0xBAD);

    MockPriceOracle private oracle;
    OracleNUSDv2 private nusd;

    function setUp() public {
        vm.warp(1_000_000);
        oracle = new MockPriceOracle(PRICE);
        nusd = _deploy(CEILING);
        vm.deal(ALICE, 100_000 ether);
        vm.deal(BOB, 100_000 ether);
    }

    function _deploy(uint256 ceiling) private returns (OracleNUSDv2) {
        return new OracleNUSDv2(IPriceOracle(address(oracle)), address(this), ceiling);
    }

    function _mint(OracleNUSDv2 token, address account, uint256 collateralWei) private returns (uint256 amount) {
        vm.prank(account);
        amount = token.mintAtOracle{value: collateralWei}(0, account);
    }

    // ---------------------------------------------------------------- mint and redeem

    function testMintAndRedeemAtOneDollarWhileBacked() public {
        assertEq(_mint(nusd, ALICE, 1 ether), 100 ether, "1 zkLTC at $100");
        assertEq(nusd.totalCollateralWei(), 1 ether, "reserve");
        assertEq(nusd.backingRatioWad(), 1e18, "fully backed");

        uint256 before = ALICE.balance;
        vm.prank(ALICE);
        uint256 out = nusd.redeemAtOracle(40 ether, 0.4 ether, ALICE);
        assertEq(out, 0.4 ether, "$40 of zkLTC");
        assertEq(ALICE.balance - before, out, "paid");
        assertEq(nusd.totalSupply(), 60 ether, "burned");
        assertEq(nusd.totalCollateralWei(), 0.6 ether, "reserve left");
    }

    function testFeesStayInTheReserve() public {
        nusd.setFees(50, 50);
        assertEq(_mint(nusd, ALICE, 1 ether), 99.5 ether, "0.5% mint fee");
        assertEq(_mint(nusd, BOB, 1 ether), 99.5 ether, "0.5% mint fee");
        assertEq(nusd.totalCollateralWei(), 2 ether, "whole deposits kept");
        assertGt(nusd.backingRatioWad(), 1e18, "fees raise backing");

        // Over-backed: the oracle value is the lower leg, then the 0.5% redeem fee.
        assertEq(nusd.quoteRedeem(99.5 ether), 0.990025 ether, "oracle value minus fee");

        vm.expectRevert(OracleNUSDv2.InvalidFee.selector);
        nusd.setFees(51, 0);
        vm.expectRevert(OracleNUSDv2.InvalidFee.selector);
        nusd.setFees(0, 51);
    }

    function testMintGuards() public {
        vm.prank(ALICE);
        vm.expectRevert(OracleNUSDv2.InvalidAmount.selector);
        nusd.mintAtOracle(0, ALICE);

        vm.prank(ALICE);
        vm.expectRevert(OracleNUSDv2.InvalidRecipient.selector);
        nusd.mintAtOracle{value: 1 ether}(0, address(0));

        vm.prank(ALICE);
        vm.expectRevert(abi.encodeWithSelector(OracleNUSDv2.SlippageExceeded.selector, 101 ether, 100 ether));
        nusd.mintAtOracle{value: 1 ether}(101 ether, ALICE);

        vm.prank(STRANGER);
        vm.expectRevert();
        nusd.setMintPaused(true);

        nusd.setMintPaused(true);
        vm.prank(ALICE);
        vm.expectRevert(OracleNUSDv2.MintPaused.selector);
        nusd.mintAtOracle{value: 1 ether}(0, ALICE);
    }

    function testRedeemCanNeverBePaused() public {
        _mint(nusd, ALICE, 1 ether);
        nusd.setMintPaused(true);

        vm.prank(ALICE);
        assertEq(nusd.redeemAtOracle(100 ether, 0, ALICE), 1 ether, "redeem open while mint is paused");

        (bool ok,) = address(nusd).call(abi.encodeWithSignature("setRedeemPaused(bool)", true));
        assertFalse(ok, "a redeem pause exists");
        (ok,) = address(nusd).call(abi.encodeWithSignature("redeemPaused()"));
        assertFalse(ok, "a redeem pause flag exists");
    }

    function testUnderBackedRedeemIsProRataWhateverTheOrder() public {
        _mint(nusd, ALICE, 1 ether);
        _mint(nusd, BOB, 1 ether);
        oracle.setPrice(50 ether); // reserve now worth $100 against 200 NUSD

        assertEq(nusd.quoteRedeem(100 ether), 1 ether, "fair share, not $100 of zkLTC");
        vm.prank(ALICE);
        nusd.redeemAtOracle(50 ether, 0, ALICE);
        assertEq(nusd.quoteRedeem(100 ether), 1 ether, "early exit took nothing from the rest");

        // LTC recovers: whoever stayed is back to $1 per NUSD.
        oracle.setPrice(PRICE);
        assertEq(nusd.backingRatioWad(), 1e18, "peg restored");
        vm.prank(BOB);
        assertEq(nusd.redeemAtOracle(100 ether, 0, BOB), 1 ether, "$100 for 100 NUSD");
    }

    function testRedeemGuards() public {
        _mint(nusd, ALICE, 1 ether);
        assertEq(nusd.quoteRedeem(0), 0, "zero");
        assertEq(nusd.quoteRedeem(101 ether), 0, "more than supply");

        vm.prank(ALICE);
        vm.expectRevert(OracleNUSDv2.InvalidRecipient.selector);
        nusd.redeemAtOracle(1 ether, 0, address(0));

        vm.prank(ALICE);
        vm.expectRevert(abi.encodeWithSelector(OracleNUSDv2.SlippageExceeded.selector, 2 ether, 1 ether));
        nusd.redeemAtOracle(100 ether, 2 ether, ALICE);

        vm.prank(BOB);
        vm.expectRevert(abi.encodeWithSelector(OracleNUSDv2.ERC20InsufficientBalance.selector, BOB, 0, 1 ether));
        nusd.redeemAtOracle(1 ether, 0, BOB);
    }

    // ---------------------------------------------------------------- supply ceiling

    function testCeilingDoublesWhenEightyPercentIsUsedAtMostWeekly() public {
        OracleNUSDv2 token = _deploy(1_000 ether);

        _mint(token, ALICE, 7.9 ether);
        assertEq(token.supplyCeilingNusd(), 1_000 ether, "790 is below 80%");

        _mint(token, ALICE, 0.2 ether);
        assertEq(token.supplyCeilingNusd(), 2_000 ether, "the mint that crosses 80% doubles it");
        assertEq(token.lastCeilingRaiseAt(), vm.getBlockTimestamp(), "raise time");

        _mint(token, ALICE, 9 ether);
        assertEq(token.supplyCeilingNusd(), 2_000 ether, "one raise per week");

        vm.prank(ALICE);
        vm.expectRevert(abi.encodeWithSelector(OracleNUSDv2.SupplyCeilingExceeded.selector, 300 ether, 290 ether));
        token.mintAtOracle{value: 3 ether}(0, ALICE);

        vm.warp(vm.getBlockTimestamp() + 7 days);
        _mint(token, ALICE, 3 ether);
        assertEq(token.supplyCeilingNusd(), 4_000 ether, "doubles again a week later");
        assertEq(token.totalSupply(), 2_010 ether, "minted");
    }

    function testOwnerSetsTheCeilingButNeverBelowSupply() public {
        _mint(nusd, ALICE, 1 ether);

        vm.expectRevert(OracleNUSDv2.InvalidSupplyCeiling.selector);
        nusd.setSupplyCeiling(99 ether);
        vm.expectRevert(OracleNUSDv2.InvalidSupplyCeiling.selector);
        nusd.setSupplyCeiling(uint256(type(uint96).max) + 1);
        vm.prank(STRANGER);
        vm.expectRevert();
        nusd.setSupplyCeiling(5_000 ether);

        nusd.setSupplyCeiling(100 ether);
        assertEq(nusd.supplyCeilingNusd(), 100 ether, "set to supply");

        vm.expectRevert(OracleNUSDv2.InvalidSupplyCeiling.selector);
        _deploy(0);
    }

    // ---------------------------------------------------------------- surplus

    function testSurplusMintsDownToThreeTimesEightyTwenty() public {
        nusd.setSurplusRecipients(STAKING, TREASURY, 2_000);
        _mint(nusd, ALICE, 1 ether); // 100 NUSD

        oracle.setPrice(329 ether);
        (, bool ready) = nusd.surplusMintCapacity();
        assertFalse(ready, "3.29x is below the 3.3x trigger");
        vm.expectRevert(abi.encodeWithSelector(OracleNUSDv2.SurplusBelowTrigger.selector, 329 ether, 100 ether));
        nusd.releaseSurplus();

        oracle.setPrice(330 ether);
        (uint256 capacity, bool readyNow) = nusd.surplusMintCapacity();
        assertTrue(readyNow, "3.3x triggers");
        assertEq(capacity, 10 ether, "down to 3.0x");

        vm.prank(STRANGER);
        assertEq(nusd.releaseSurplus(), 10 ether, "permissionless");
        assertEq(nusd.balanceOf(STAKING), 8 ether, "80% to stakers");
        assertEq(nusd.balanceOf(TREASURY), 2 ether, "20% to treasury");
        assertEq(nusd.backingRatioWad(), 3e18, "exactly 3.0x");

        oracle.setPrice(1_000 ether);
        uint256 nextAt = vm.getBlockTimestamp() + 7 days;
        vm.expectRevert(abi.encodeWithSelector(OracleNUSDv2.SurplusTooSoon.selector, nextAt));
        nusd.releaseSurplus();

        vm.warp(nextAt);
        nusd.releaseSurplus();
        assertGe(nusd.backingRatioWad(), 3e18, "never below the floor");
        assertLe(nusd.backingRatioWad(), 3e18 + 1e9, "lands on the floor");
    }

    function testSurplusWaitsForRecipientsAndHonoursItsBounds() public {
        _mint(nusd, ALICE, 1 ether);
        oracle.setPrice(1_000 ether);
        (, bool ready) = nusd.surplusMintCapacity();
        assertFalse(ready, "no recipients yet");
        vm.expectRevert(OracleNUSDv2.SurplusRecipientUnset.selector);
        nusd.releaseSurplus();

        vm.expectRevert(OracleNUSDv2.InvalidSurplusSplit.selector);
        nusd.setSurplusRecipients(STAKING, TREASURY, 2_001);
        vm.expectRevert(OracleNUSDv2.InvalidRecipient.selector);
        nusd.setSurplusRecipients(STAKING, STAKING, 0);
        vm.expectRevert(OracleNUSDv2.InvalidRecipient.selector);
        nusd.setSurplusRecipients(address(0), TREASURY, 0);
        vm.prank(STRANGER);
        vm.expectRevert();
        nusd.setSurplusRecipients(STAKING, TREASURY, 0);

        vm.expectRevert(OracleNUSDv2.InvalidSurplusRatios.selector);
        nusd.setSurplusRatios(14_999, 20_000);
        vm.expectRevert(OracleNUSDv2.InvalidSurplusRatios.selector);
        nusd.setSurplusRatios(20_000, 20_999);
        vm.expectRevert(OracleNUSDv2.InvalidSurplusRatios.selector);
        nusd.setSurplusRatios(60_000, 70_000);
        nusd.setSurplusRatios(20_000, 21_000);
        assertEq(nusd.surplusFloorBps(), 20_000, "floor");
        assertEq(nusd.surplusTriggerBps(), 21_000, "trigger");

        // A zero treasury share sends everything to the stakers.
        nusd.setSurplusRecipients(STAKING, TREASURY, 0);
        nusd.releaseSurplus();
        assertEq(nusd.balanceOf(TREASURY), 0, "no treasury share");
        assertEq(nusd.balanceOf(STAKING), 400 ether, "$1,000 reserve at 2.0x is 500 NUSD");
    }

    function testSurplusStopsAtTheSupplyCeiling() public {
        OracleNUSDv2 token = _deploy(105 ether);
        token.setSurplusRecipients(STAKING, TREASURY, 2_000);
        _mint(token, ALICE, 1 ether); // 100 NUSD, ceiling raised to 210 by the 80% rule
        assertEq(token.supplyCeilingNusd(), 210 ether, "auto-raised");
        token.setSupplyCeiling(105 ether);

        oracle.setPrice(1_000 ether);
        assertEq(token.releaseSurplus(), 5 ether, "only the headroom");
        assertEq(token.totalSupply(), 105 ether, "at the ceiling");
        assertEq(token.balanceOf(STAKING), 4 ether, "80%");
        assertEq(token.balanceOf(TREASURY), 1 ether, "20%");
    }

    function testSurplusFailsClosedWhileTheOracleIsDown() public {
        nusd.setSurplusRecipients(STAKING, TREASURY, 2_000);
        _mint(nusd, ALICE, 1 ether);
        oracle.setBroken(true);
        vm.expectRevert();
        nusd.releaseSurplus();
        vm.expectRevert();
        nusd.surplusMintCapacity();
    }

    // ---------------------------------------------------------------- oracle failure exit

    function testOracleFailureExitPaysProRataAfterTheGrace() public {
        _mint(nusd, ALICE, 1 ether);
        _mint(nusd, BOB, 3 ether);

        vm.expectRevert(OracleNUSDv2.OracleHealthy.selector);
        nusd.reportOracleFailure();

        oracle.setBroken(true);
        vm.prank(ALICE);
        vm.expectRevert(OracleNUSDv2.OracleFailureNotReported.selector);
        nusd.emergencyRedeem(100 ether, 0, ALICE);

        vm.prank(STRANGER);
        nusd.reportOracleFailure();
        uint256 reportedAt = vm.getBlockTimestamp();
        assertEq(nusd.oracleFailureReportedAt(), reportedAt, "clock started");
        nusd.reportOracleFailure(); // idempotent
        assertEq(nusd.oracleFailureReportedAt(), reportedAt, "clock not restarted");

        vm.prank(ALICE);
        vm.expectRevert(abi.encodeWithSelector(OracleNUSDv2.OracleFailureGracePending.selector, reportedAt + 7 days));
        nusd.emergencyRedeem(100 ether, 0, ALICE);

        vm.warp(reportedAt + 7 days);
        uint256 before = ALICE.balance;
        vm.prank(ALICE);
        assertEq(nusd.emergencyRedeem(100 ether, 0, ALICE), 1 ether, "100 of 400 NUSD takes 1 of 4 zkLTC");
        assertEq(ALICE.balance - before, 1 ether, "paid");
        vm.prank(BOB);
        assertEq(nusd.emergencyRedeem(300 ether, 0, BOB), 3 ether, "the order does not matter");
    }

    function testOracleRecoveryClosesTheExit() public {
        _mint(nusd, ALICE, 1 ether);
        oracle.setBroken(true);
        nusd.reportOracleFailure();
        vm.expectRevert(OracleNUSDv2.OracleUnavailable.selector);
        nusd.clearOracleFailure();

        vm.warp(vm.getBlockTimestamp() + 7 days);
        oracle.setBroken(false);
        vm.prank(ALICE);
        vm.expectRevert(OracleNUSDv2.OracleHealthy.selector);
        nusd.emergencyRedeem(100 ether, 0, ALICE);

        vm.prank(STRANGER);
        nusd.clearOracleFailure();
        assertEq(nusd.oracleFailureReportedAt(), 0, "clock cleared");
    }

    // ---------------------------------------------------------------- reserve

    function testBurnAndDonationsRaiseBacking() public {
        _mint(nusd, ALICE, 1 ether);
        vm.prank(ALICE);
        nusd.burn(50 ether);
        assertEq(nusd.totalSupply(), 50 ether, "supply");
        assertEq(nusd.backingRatioWad(), 2e18, "collateral stayed");

        nusd.coverReserve{value: 1 ether}();
        assertEq(nusd.backingRatioWad(), 4e18, "cover");
        (bool ok,) = address(nusd).call{value: 1 ether}("");
        assertTrue(ok, "plain transfer accepted");
        assertEq(nusd.totalCollateralWei(), 3 ether, "joins the reserve");

        vm.expectRevert(OracleNUSDv2.InvalidAmount.selector);
        nusd.coverReserve();
    }

    // ---------------------------------------------------------------- fuzz

    /// Redeeming never pays more than the oracle value or the fair share, and never lowers the
    /// backing of the NUSD that stays.
    function testFuzzRedeemNeverOverpays(uint256 rawA, uint256 rawB, uint256 rawPrice, uint256 rawRedeem) public {
        _mint(nusd, ALICE, bound(rawA, 0.001 ether, 1_000 ether));
        _mint(nusd, BOB, bound(rawB, 0.001 ether, 1_000 ether));
        uint256 price = bound(rawPrice, 1 ether, 1_000 ether);
        oracle.setPrice(price);
        uint256 amount = bound(rawRedeem, 1, nusd.balanceOf(ALICE));

        uint256 supplyBefore = nusd.totalSupply();
        uint256 collateralBefore = nusd.totalCollateralWei();
        uint256 out = nusd.quoteRedeem(amount);
        assertLe(out, amount * 1e18 / price, "above oracle value");
        assertLe(out, amount * collateralBefore / supplyBefore, "above fair share");
        if (out == 0) return;

        vm.prank(ALICE);
        nusd.redeemAtOracle(amount, out, ALICE);
        uint256 supplyAfter = nusd.totalSupply();
        uint256 collateralAfter = nusd.totalCollateralWei();
        assertGe(collateralAfter * supplyBefore, collateralBefore * supplyAfter, "remaining backing fell");
    }

    function testFuzzSurplusKeepsTheFloor(uint256 rawDeposit, uint256 rawPrice) public {
        nusd.setSurplusRecipients(STAKING, TREASURY, 2_000);
        _mint(nusd, ALICE, bound(rawDeposit, 0.001 ether, 1_000 ether));
        oracle.setPrice(bound(rawPrice, PRICE, 100_000 ether));
        (uint256 capacity, bool ready) = nusd.surplusMintCapacity();
        if (!ready) return;

        uint256 released = nusd.releaseSurplus();
        assertEq(released, capacity, "capacity");
        assertGe(nusd.backingRatioWad(), 3e18, "below 3.0x");
        assertEq(nusd.balanceOf(STAKING) + nusd.balanceOf(TREASURY), released, "split loses NUSD");
        assertLe(nusd.balanceOf(TREASURY), released / 5, "treasury above 20%");
    }
}
