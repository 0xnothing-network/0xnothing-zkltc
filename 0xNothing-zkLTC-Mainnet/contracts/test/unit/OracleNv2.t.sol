// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {TestBase} from "../TestBase.sol";
import {OracleNv2} from "../../src/n/OracleNv2.sol";
import {IPriceOracle} from "../../src/oracle/IPriceOracle.sol";
import {MockPriceOracle} from "../mocks/TokenomicsMocks.sol";

contract OracleNv2Test is TestBase {
    uint256 private constant PRICE = 100 ether; // $100 per zkLTC
    uint256 private constant CEILING = 1_000_000 ether;

    address private constant ALICE = address(0xA11CE);
    address private constant BOB = address(0xB0B);
    address private constant STAKING = address(0x57A6);
    address private constant TREASURY = address(0x7EA5);
    address private constant STRANGER = address(0xBAD);

    MockPriceOracle private oracle;
    OracleNv2 private n;

    function setUp() public {
        vm.warp(1_000_000);
        oracle = new MockPriceOracle(PRICE);
        n = _deploy(CEILING);
        vm.deal(ALICE, 100_000 ether);
        vm.deal(BOB, 100_000 ether);
    }

    function _deploy(uint256 ceiling) private returns (OracleNv2) {
        return new OracleNv2(IPriceOracle(address(oracle)), address(this), ceiling);
    }

    function _mint(OracleNv2 token, address account, uint256 collateralWei) private returns (uint256 amount) {
        vm.prank(account);
        amount = token.mintAtOracle{value: collateralWei}(0, account);
    }

    // ---------------------------------------------------------------- mint and redeem

    function testMintAndRedeemAtOneDollarWhileBacked() public {
        assertEq(_mint(n, ALICE, 1 ether), 100 ether, "1 zkLTC at $100");
        assertEq(n.totalCollateralWei(), 1 ether, "reserve");
        assertEq(n.backingRatioWad(), 1e18, "fully backed");

        uint256 before = ALICE.balance;
        vm.prank(ALICE);
        uint256 out = n.redeemAtOracle(40 ether, 0.4 ether, ALICE);
        assertEq(out, 0.4 ether, "$40 of zkLTC");
        assertEq(ALICE.balance - before, out, "paid");
        assertEq(n.totalSupply(), 60 ether, "burned");
        assertEq(n.totalCollateralWei(), 0.6 ether, "reserve left");
    }

    function testFeesStayInTheReserve() public {
        n.setFees(50, 50);
        assertEq(_mint(n, ALICE, 1 ether), 99.5 ether, "0.5% mint fee");
        assertEq(_mint(n, BOB, 1 ether), 99.5 ether, "0.5% mint fee");
        assertEq(n.totalCollateralWei(), 2 ether, "whole deposits kept");
        assertGt(n.backingRatioWad(), 1e18, "fees raise backing");

        // Over-backed: the oracle value is the lower leg, then the 0.5% redeem fee.
        assertEq(n.quoteRedeem(99.5 ether), 0.990025 ether, "oracle value minus fee");

        vm.expectRevert(OracleNv2.InvalidFee.selector);
        n.setFees(201, 0);
        vm.expectRevert(OracleNv2.InvalidFee.selector);
        n.setFees(0, 201);
        n.setFees(200, 200);
        assertEq(n.mintFeeBps(), 200, "fees reach 2% for coarse feeds");
    }

    function testMintGuards() public {
        vm.prank(ALICE);
        vm.expectRevert(OracleNv2.InvalidAmount.selector);
        n.mintAtOracle(0, ALICE);

        vm.prank(ALICE);
        vm.expectRevert(OracleNv2.InvalidRecipient.selector);
        n.mintAtOracle{value: 1 ether}(0, address(0));

        vm.prank(ALICE);
        vm.expectRevert(abi.encodeWithSelector(OracleNv2.SlippageExceeded.selector, 101 ether, 100 ether));
        n.mintAtOracle{value: 1 ether}(101 ether, ALICE);

        vm.prank(STRANGER);
        vm.expectRevert();
        n.setMintPaused(true);

        n.setMintPaused(true);
        vm.prank(ALICE);
        vm.expectRevert(OracleNv2.MintPaused.selector);
        n.mintAtOracle{value: 1 ether}(0, ALICE);
    }

    function testRedeemCanNeverBePaused() public {
        _mint(n, ALICE, 1 ether);
        n.setMintPaused(true);

        vm.prank(ALICE);
        assertEq(n.redeemAtOracle(100 ether, 0, ALICE), 1 ether, "redeem open while mint is paused");

        (bool ok,) = address(n).call(abi.encodeWithSignature("setRedeemPaused(bool)", true));
        assertFalse(ok, "a redeem pause exists");
        (ok,) = address(n).call(abi.encodeWithSignature("redeemPaused()"));
        assertFalse(ok, "a redeem pause flag exists");
    }

    function testUnderBackedRedeemIsProRataWhateverTheOrder() public {
        _mint(n, ALICE, 1 ether);
        _mint(n, BOB, 1 ether);
        oracle.setPrice(50 ether); // reserve now worth $100 against 200 N

        assertEq(n.quoteRedeem(100 ether), 1 ether, "fair share, not $100 of zkLTC");
        vm.prank(ALICE);
        n.redeemAtOracle(50 ether, 0, ALICE);
        assertEq(n.quoteRedeem(100 ether), 1 ether, "early exit took nothing from the rest");

        // LTC recovers: whoever stayed is back to $1 per N.
        oracle.setPrice(PRICE);
        assertEq(n.backingRatioWad(), 1e18, "peg restored");
        vm.prank(BOB);
        assertEq(n.redeemAtOracle(100 ether, 0, BOB), 1 ether, "$100 for 100 N");
    }

    function testRedeemGuards() public {
        _mint(n, ALICE, 1 ether);
        assertEq(n.quoteRedeem(0), 0, "zero");
        assertEq(n.quoteRedeem(101 ether), 0, "more than supply");

        vm.prank(ALICE);
        vm.expectRevert(OracleNv2.InvalidRecipient.selector);
        n.redeemAtOracle(1 ether, 0, address(0));

        vm.prank(ALICE);
        vm.expectRevert(abi.encodeWithSelector(OracleNv2.SlippageExceeded.selector, 2 ether, 1 ether));
        n.redeemAtOracle(100 ether, 2 ether, ALICE);

        vm.prank(BOB);
        vm.expectRevert(abi.encodeWithSelector(OracleNv2.ERC20InsufficientBalance.selector, BOB, 0, 1 ether));
        n.redeemAtOracle(1 ether, 0, BOB);
    }

    // ---------------------------------------------------------------- supply ceiling

    function testCeilingDoublesWhenEightyPercentIsUsedAtMostWeekly() public {
        OracleNv2 token = _deploy(1_000 ether);

        _mint(token, ALICE, 7.9 ether);
        assertEq(token.supplyCeilingN(), 1_000 ether, "790 is below 80%");

        _mint(token, ALICE, 0.2 ether);
        assertEq(token.supplyCeilingN(), 2_000 ether, "the mint that crosses 80% doubles it");
        assertEq(token.lastCeilingRaiseAt(), vm.getBlockTimestamp(), "raise time");

        _mint(token, ALICE, 9 ether);
        assertEq(token.supplyCeilingN(), 2_000 ether, "one raise per week");

        vm.prank(ALICE);
        vm.expectRevert(abi.encodeWithSelector(OracleNv2.SupplyCeilingExceeded.selector, 300 ether, 290 ether));
        token.mintAtOracle{value: 3 ether}(0, ALICE);

        vm.warp(vm.getBlockTimestamp() + 7 days);
        _mint(token, ALICE, 3 ether);
        assertEq(token.supplyCeilingN(), 4_000 ether, "doubles again a week later");
        assertEq(token.totalSupply(), 2_010 ether, "minted");
    }

    function testOwnerSetsTheCeilingButNeverBelowSupply() public {
        _mint(n, ALICE, 1 ether);

        vm.expectRevert(OracleNv2.InvalidSupplyCeiling.selector);
        n.setSupplyCeiling(99 ether);
        vm.expectRevert(OracleNv2.InvalidSupplyCeiling.selector);
        n.setSupplyCeiling(uint256(type(uint96).max) + 1);
        vm.prank(STRANGER);
        vm.expectRevert();
        n.setSupplyCeiling(5_000 ether);

        n.setSupplyCeiling(100 ether);
        assertEq(n.supplyCeilingN(), 100 ether, "set to supply");

        vm.expectRevert(OracleNv2.InvalidSupplyCeiling.selector);
        _deploy(0);
    }

    // ---------------------------------------------------------------- surplus

    function testSurplusMintsDownToThreeTimesEightyTwenty() public {
        n.setSurplusRecipients(STAKING, TREASURY, 2_000);
        _mint(n, ALICE, 1 ether); // 100 N

        oracle.setPrice(329 ether);
        (, bool ready) = n.surplusMintCapacity();
        assertFalse(ready, "3.29x is below the 3.3x trigger");
        vm.expectRevert(abi.encodeWithSelector(OracleNv2.SurplusBelowTrigger.selector, 329 ether, 100 ether));
        n.releaseSurplus();

        oracle.setPrice(330 ether);
        (uint256 capacity, bool readyNow) = n.surplusMintCapacity();
        assertTrue(readyNow, "3.3x triggers");
        assertEq(capacity, 10 ether, "down to 3.0x");

        vm.prank(STRANGER);
        assertEq(n.releaseSurplus(), 10 ether, "permissionless");
        assertEq(n.balanceOf(STAKING), 8 ether, "80% to stakers");
        assertEq(n.balanceOf(TREASURY), 2 ether, "20% to treasury");
        assertEq(n.backingRatioWad(), 3e18, "exactly 3.0x");

        oracle.setPrice(1_000 ether);
        uint256 nextAt = vm.getBlockTimestamp() + 7 days;
        vm.expectRevert(abi.encodeWithSelector(OracleNv2.SurplusTooSoon.selector, nextAt));
        n.releaseSurplus();

        // Far above the trigger a release is still one step: what a release exactly at the trigger
        // mints, a tenth of the supply. The rest follows a week at a time.
        vm.warp(nextAt);
        (capacity,) = n.surplusMintCapacity();
        assertEq(capacity, 11 ether, "a tenth of 110 N, not the 223.33 that 9.09x has room for");
        assertEq(n.releaseSurplus(), 11 ether, "one step");
        assertEq(n.balanceOf(STAKING), 8 ether + 8.8 ether, "80% of it to stakers");
        vm.warp(nextAt + 7 days);
        assertEq(n.releaseSurplus(), 12.1 ether, "the next step a week later, on the larger supply");
        assertEq(n.totalSupply(), 133.1 ether, "100 + 10 + 11 + 12.1");
        assertGe(n.backingRatioWad(), 3e18, "never below the floor");
    }

    function testSurplusWaitsForRecipientsAndHonoursItsBounds() public {
        _mint(n, ALICE, 1 ether);
        oracle.setPrice(1_000 ether);
        (, bool ready) = n.surplusMintCapacity();
        assertFalse(ready, "no recipients yet");
        vm.expectRevert(OracleNv2.SurplusRecipientUnset.selector);
        n.releaseSurplus();

        vm.expectRevert(OracleNv2.InvalidSurplusSplit.selector);
        n.setSurplusRecipients(STAKING, TREASURY, 2_001);
        vm.expectRevert(OracleNv2.InvalidRecipient.selector);
        n.setSurplusRecipients(STAKING, STAKING, 0);
        vm.expectRevert(OracleNv2.InvalidRecipient.selector);
        n.setSurplusRecipients(address(0), TREASURY, 0);
        vm.prank(STRANGER);
        vm.expectRevert();
        n.setSurplusRecipients(STAKING, TREASURY, 0);

        vm.expectRevert(OracleNv2.InvalidSurplusRatios.selector);
        n.setSurplusRatios(14_999, 20_000);
        vm.expectRevert(OracleNv2.InvalidSurplusRatios.selector);
        n.setSurplusRatios(20_000, 20_999);
        vm.expectRevert(OracleNv2.InvalidSurplusRatios.selector);
        n.setSurplusRatios(60_000, 70_000);
        n.setSurplusRatios(20_000, 21_000);
        assertEq(n.surplusFloorBps(), 20_000, "floor");
        assertEq(n.surplusTriggerBps(), 21_000, "trigger");

        // A zero treasury share sends everything to the stakers. The step follows the two ratios:
        // at 2.1x over 2.0x a release mints a twentieth of the supply.
        n.setSurplusRecipients(STAKING, TREASURY, 0);
        n.releaseSurplus();
        assertEq(n.balanceOf(TREASURY), 0, "no treasury share");
        assertEq(n.balanceOf(STAKING), 5 ether, "one step of 100 N at 2.1x over 2.0x");
    }

    /// A release is never cut down to what the ceiling has room for: it waits until all of it
    /// fits, and it lifts the ceiling when a mint of one wei would.
    function testSurplusWaitsForRoomUnderTheSupplyCeiling() public {
        OracleNv2 token = _deploy(105 ether);
        token.setSurplusRecipients(STAKING, TREASURY, 2_000);
        _mint(token, ALICE, 1 ether); // 100 N, ceiling raised to 210 by the 80% rule
        assertEq(token.supplyCeilingN(), 210 ether, "auto-raised");
        token.setSupplyCeiling(105 ether);

        oracle.setPrice(1_000 ether);
        (uint256 capacity, bool ready) = token.surplusMintCapacity();
        assertEq(capacity, 0, "the step of 10 does not fit in a headroom of 5");
        assertFalse(ready, "so nothing is released");
        vm.expectRevert(abi.encodeWithSelector(OracleNv2.SurplusBelowTrigger.selector, 1_000 ether, 100 ether));
        token.releaseSurplus();
        assertEq(token.lastSurplusReleaseAt(), 0, "and the week is not used up");

        // The admin makes room for exactly one step: it goes out whole and fills the ceiling.
        token.setSupplyCeiling(110 ether);
        assertEq(token.releaseSurplus(), 10 ether, "the whole step once it fits exactly");
        assertEq(token.totalSupply(), 110 ether, "at the ceiling");
        assertEq(token.balanceOf(STAKING), 8 ether, "80%");
        assertEq(token.balanceOf(TREASURY), 2 ether, "20%");
        vm.prank(BOB);
        vm.expectRevert(abi.encodeWithSelector(OracleNv2.SupplyCeilingExceeded.selector, 1_000 ether, 0));
        token.mintAtOracle{value: 1 ether}(0, BOB);

        // A week after the last raise the next release lifts the ceiling itself, as a mint would.
        vm.warp(vm.getBlockTimestamp() + 7 days);
        assertEq(token.releaseSurplus(), 11 ether, "a tenth of 110, with nobody minting first");
        assertEq(token.supplyCeilingN(), 220 ether, "doubled by the release");
        assertEq(token.lastCeilingRaiseAt(), vm.getBlockTimestamp(), "and counted as this week's raise");
    }

    function testSurplusCountsRedeemedSupplyForOneToTwoWeeks() public {
        n.setSurplusRecipients(STAKING, TREASURY, 2_000);
        _mint(n, ALICE, 1 ether); // 100 N
        n.coverReserve{value: 2.2 ether}(); // $320 behind 100 N: 3.2x, below the trigger
        assertEq(n.surplusSupplyBasis(), 100 ether, "no redemption yet: the supply itself");

        vm.prank(ALICE);
        n.redeemAtOracle(10 ether, 0, ALICE); // $310 behind 90 N: 3.44x on the raw supply
        assertEq(n.surplusSupplyBasis(), 100 ether, "the supply the redemption started from");
        (, bool ready) = n.surplusMintCapacity();
        assertFalse(ready, "3.1x against the remembered 100 N");
        vm.expectRevert(abi.encodeWithSelector(OracleNv2.SurplusBelowTrigger.selector, 310 ether, 100 ether));
        n.releaseSurplus();

        // Epochs are whole weeks of chain time. Still remembered throughout the next one ...
        uint256 epoch = vm.getBlockTimestamp() / 7 days;
        vm.warp((epoch + 2) * 7 days - 1);
        assertEq(n.surplusSupplyBasis(), 100 ether, "remembered through the following epoch");
        // ... and forgotten the moment the one after it begins.
        vm.warp((epoch + 2) * 7 days);
        assertEq(n.surplusSupplyBasis(), 90 ether, "then only the real supply counts");
        assertEq(n.releaseSurplus(), 9 ether, "one step of the lasting supply (3.44x has room for 13.33)");
    }

    function testPlainBurnCountsTowardTheSurplusAtOnce() public {
        n.setSurplusRecipients(STAKING, TREASURY, 2_000);
        _mint(n, ALICE, 1 ether); // 100 N
        n.coverReserve{value: 2.2 ether}(); // 3.2x

        // A burn leaves its collateral in the reserve, so it cannot be undone by minting back.
        vm.prank(ALICE);
        n.burn(4 ether);
        assertEq(n.surplusSupplyBasis(), 96 ether, "not remembered");
        assertEq(n.releaseSurplus(), 9.6 ether, "3.33x releases one step of the 96 N left");
    }

    function testMintPauseAlsoStopsTheSurplusRelease() public {
        n.setSurplusRecipients(STAKING, TREASURY, 2_000);
        _mint(n, ALICE, 1 ether);
        oracle.setPrice(400 ether);
        n.setMintPaused(true);
        (, bool ready) = n.surplusMintCapacity();
        assertFalse(ready, "paused");
        vm.expectRevert(OracleNv2.MintPaused.selector);
        n.releaseSurplus();

        n.setMintPaused(false);
        assertGt(n.releaseSurplus(), 0, "released once minting is open again");
    }

    function testSurplusFailsClosedWhileTheOracleIsDown() public {
        n.setSurplusRecipients(STAKING, TREASURY, 2_000);
        _mint(n, ALICE, 1 ether);
        oracle.setBroken(true);
        vm.expectRevert();
        n.releaseSurplus();
        vm.expectRevert();
        n.surplusMintCapacity();
    }

    // ---------------------------------------------------------------- oracle failure exit

    function testOracleFailureExitPaysProRataAfterTheGrace() public {
        _mint(n, ALICE, 1 ether);
        _mint(n, BOB, 3 ether);

        vm.expectRevert(OracleNv2.OracleHealthy.selector);
        n.reportOracleFailure();

        oracle.setBroken(true);
        vm.prank(ALICE);
        vm.expectRevert(OracleNv2.OracleFailureNotReported.selector);
        n.emergencyRedeem(100 ether, 0, ALICE);

        vm.prank(STRANGER);
        n.reportOracleFailure();
        uint256 reportedAt = vm.getBlockTimestamp();
        assertEq(n.oracleFailureReportedAt(), reportedAt, "clock started");
        n.reportOracleFailure(); // idempotent
        assertEq(n.oracleFailureReportedAt(), reportedAt, "clock not restarted");

        vm.prank(ALICE);
        vm.expectRevert(abi.encodeWithSelector(OracleNv2.OracleFailureGracePending.selector, reportedAt + 7 days));
        n.emergencyRedeem(100 ether, 0, ALICE);

        vm.warp(reportedAt + 7 days);
        uint256 before = ALICE.balance;
        vm.prank(ALICE);
        assertEq(n.emergencyRedeem(100 ether, 0, ALICE), 1 ether, "100 of 400 N takes 1 of 4 zkLTC");
        assertEq(ALICE.balance - before, 1 ether, "paid");
        vm.prank(BOB);
        assertEq(n.emergencyRedeem(300 ether, 0, BOB), 3 ether, "the order does not matter");
    }

    function testOracleRecoveryClosesTheExit() public {
        _mint(n, ALICE, 1 ether);
        assertEq(n.oracleFailureExitAt(), 0, "no report, no exit time");
        oracle.setBroken(true);
        n.reportOracleFailure();
        assertEq(n.oracleFailureExitAt(), vm.getBlockTimestamp() + 7 days, "seven days from the report");
        vm.expectRevert(OracleNv2.OracleUnavailable.selector);
        n.clearOracleFailure();

        vm.warp(vm.getBlockTimestamp() + 7 days);
        oracle.setBroken(false);
        vm.prank(ALICE);
        vm.expectRevert(OracleNv2.OracleHealthy.selector);
        n.emergencyRedeem(100 ether, 0, ALICE);

        vm.prank(STRANGER);
        n.clearOracleFailure();
        assertEq(n.oracleFailureReportedAt(), 0, "clock cleared");
    }

    function testEveryPricedCallClearsTheFailureReport() public {
        n.setSurplusRecipients(STAKING, TREASURY, 2_000);
        _mint(n, ALICE, 1 ether);

        oracle.setBroken(true);
        n.reportOracleFailure();
        oracle.setBroken(false);
        _mint(n, BOB, 1 ether);
        assertEq(n.oracleFailureReportedAt(), 0, "a mint");

        oracle.setBroken(true);
        n.reportOracleFailure();
        oracle.setBroken(false);
        vm.prank(ALICE);
        n.redeemAtOracle(1 ether, 0, ALICE);
        assertEq(n.oracleFailureReportedAt(), 0, "a redemption");

        oracle.setBroken(true);
        n.reportOracleFailure();
        oracle.setBroken(false);
        vm.warp(vm.getBlockTimestamp() + 14 days);
        oracle.setPrice(1_000 ether);
        n.releaseSurplus();
        assertEq(n.oracleFailureReportedAt(), 0, "a surplus release");
    }

    function testATransferVoidsAReportOnlyWhileTheOraclePrices() public {
        _mint(n, ALICE, 1 ether);
        oracle.setBroken(true);
        n.reportOracleFailure();
        uint256 reportedAt = vm.getBlockTimestamp();

        vm.prank(ALICE);
        n.transfer(BOB, 10 ether);
        assertEq(n.oracleFailureReportedAt(), reportedAt, "the oracle is down: the report stands");

        oracle.setBroken(false);
        vm.prank(ALICE);
        n.approve(STRANGER, 5 ether);
        assertEq(n.oracleFailureReportedAt(), reportedAt, "an approval moves nothing");
        vm.prank(STRANGER);
        n.transferFrom(ALICE, BOB, 5 ether);
        assertEq(n.oracleFailureReportedAt(), 0, "N moved while the oracle priced: the report is void");
        assertEq(n.balanceOf(BOB), 15 ether, "and the transfer itself is unaffected");

        // A price of zero is not a price.
        oracle.setBroken(true);
        n.reportOracleFailure();
        oracle.setBroken(false);
        oracle.setPrice(0);
        vm.prank(BOB);
        n.transfer(ALICE, 1 ether);
        assertGt(n.oracleFailureReportedAt(), 0, "a zero price leaves the report standing");
    }

    // ---------------------------------------------------------------- reserve

    function testBurnAndDonationsRaiseBacking() public {
        _mint(n, ALICE, 1 ether);
        vm.prank(ALICE);
        n.burn(50 ether);
        assertEq(n.totalSupply(), 50 ether, "supply");
        assertEq(n.backingRatioWad(), 2e18, "collateral stayed");

        n.coverReserve{value: 1 ether}();
        assertEq(n.backingRatioWad(), 4e18, "cover");
        (bool ok,) = address(n).call{value: 1 ether}("");
        assertTrue(ok, "plain transfer accepted");
        assertEq(n.totalCollateralWei(), 3 ether, "joins the reserve");

        vm.expectRevert(OracleNv2.InvalidAmount.selector);
        n.coverReserve();
    }

    // ---------------------------------------------------------------- oracle-lag guards

    function testMintNeedsAFreshPrice() public {
        n.setMintGuards(10 minutes, 1_000_000 ether);
        oracle.setUpdatedAt(vm.getBlockTimestamp() - 11 minutes);
        vm.prank(ALICE);
        vm.expectRevert(
            abi.encodeWithSelector(OracleNv2.StaleMintPrice.selector, vm.getBlockTimestamp() - 11 minutes, 10 minutes)
        );
        n.mintAtOracle{value: 1 ether}(0, ALICE);

        oracle.setUpdatedAt(vm.getBlockTimestamp() - 10 minutes);
        assertEq(_mint(n, ALICE, 1 ether), 100 ether, "fresh enough");

        // Redemption never waits for a fresher price; against an old one it pays the maximum fee.
        n.setFees(0, 50);
        assertEq(n.quoteRedeem(100 ether), 0.995 ether, "fresh: the 0.5% redeem fee");
        oracle.setUpdatedAt(vm.getBlockTimestamp() - 10 minutes - 1);
        assertEq(n.quoteRedeem(100 ether), 0.98 ether, "one second too old to mint against: 2%");
        vm.prank(ALICE);
        assertEq(n.redeemAtOracle(100 ether, 0, ALICE), 0.98 ether, "redeem stays open");
        assertEq(n.totalCollateralWei(), 0.02 ether, "and the fee stays in the reserve");
    }

    function testSurplusReleaseNeedsAFreshPriceToo() public {
        n.setSurplusRecipients(STAKING, TREASURY, 2_000);
        n.setMintGuards(10 minutes, 1_000_000 ether);
        _mint(n, ALICE, 1 ether);
        oracle.setPrice(1_000 ether);
        oracle.setUpdatedAt(vm.getBlockTimestamp() - 1 hours);
        vm.expectRevert(
            abi.encodeWithSelector(OracleNv2.StaleMintPrice.selector, vm.getBlockTimestamp() - 1 hours, 10 minutes)
        );
        n.releaseSurplus();
    }

    function testMintBudgetRefillsOverAnHour() public {
        n.setMintGuards(90 minutes, 150 ether);
        _mint(n, ALICE, 1 ether);
        assertEq(n.mintAvailableInWindow(), 50 ether, "100 of 150 used");
        vm.prank(BOB);
        vm.expectRevert(abi.encodeWithSelector(OracleNv2.MintRateLimited.selector, 100 ether, 50 ether));
        n.mintAtOracle{value: 1 ether}(0, BOB);
        _mint(n, BOB, 0.5 ether);
        assertEq(n.mintAvailableInWindow(), 0, "budget spent");

        vm.warp(vm.getBlockTimestamp() + 20 minutes);
        assertEq(n.mintAvailableInWindow(), 50 ether, "a third is back after a third of the hour");
        _mint(n, BOB, 0.5 ether);
        assertEq(n.mintAvailableInWindow(), 0, "and can be spent as it returns");

        vm.warp(vm.getBlockTimestamp() + 1 hours);
        assertEq(n.mintAvailableInWindow(), 150 ether, "whole again an hour after the last mint");
        _mint(n, BOB, 1 ether);
        assertEq(n.mintedInWindow(), 100 ether, "counted from an empty budget");

        // Lowering the limit below what is counted stops minting until it has drained.
        n.setMintGuards(90 minutes, 60 ether);
        assertEq(n.mintAvailableInWindow(), 0, "100 counted against a budget of 60");
        vm.warp(vm.getBlockTimestamp() + 50 minutes);
        assertEq(n.mintAvailableInWindow(), 10 ether, "50 of the 100 drained at the new rate");
    }

    /// With the reserve well above 1x (the designed state), a trade against a lagging price does
    /// not pay while the lag is within the fee of the leg it uses: the mint leg yields no more
    /// N than the deposit is worth at the market, the redeem leg no more zkLTC than the N is
    /// worth at the market. The lag is measured from the oracle price, like a feed's threshold.
    function testFuzzLagWithinTheFeeOfALegIsUnprofitable(uint256 rawFee, uint256 rawLag, uint256 rawDeposit) public {
        uint256 fee = bound(rawFee, 0, 200);
        uint256 lag = bound(rawLag, 0, fee);
        uint256 deposit = bound(rawDeposit, 0.01 ether, 100 ether);
        n.setFees(fee, fee);
        _mint(n, BOB, 300 ether);
        n.coverReserve{value: 600 ether}(); // about 3x: the pro-rata leg never caps a payout

        // Mint leg: the market is `lag` below the oracle.
        uint256 minted = _mint(n, ALICE, deposit);
        assertLe(minted, deposit * (PRICE * (10_000 - lag) / 10_000) / 1e18 + 1, "the mint leg paid");

        // Redeem leg: the market is `lag` above the oracle.
        vm.prank(ALICE);
        uint256 out = n.redeemAtOracle(minted, 0, ALICE);
        assertLe(out, minted * 1e18 / (PRICE * (10_000 + lag) / 10_000) + 1, "the redeem leg paid");
    }

    /// A round trip across one price update never pays while the move is within the two fees
    /// together: mint at the old price, redeem at the new one, and get back no more zkLTC.
    function testFuzzRoundTripWithinBothFeesIsUnprofitable(uint256 rawFee, uint256 rawDrop, uint256 rawDeposit)
        public
    {
        uint256 fee = bound(rawFee, 0, 200);
        // (1 - f)^2 <= 1 - d  <=>  d <= 2f - f^2 (in bps: 2f - f^2 / 10_000, the last term rounded up)
        uint256 drop = bound(rawDrop, 0, 2 * fee - (fee * fee + 9_999) / 10_000);
        uint256 deposit = bound(rawDeposit, 0.01 ether, 100 ether);
        n.setFees(fee, fee);
        _mint(n, BOB, 300 ether);
        n.coverReserve{value: 600 ether}(); // about 3x, so nothing but the fees stands in the way
        uint256 minted = _mint(n, ALICE, deposit);
        oracle.setPrice(PRICE * (10_000 - drop) / 10_000);
        vm.prank(ALICE);
        uint256 out = n.redeemAtOracle(minted, 0, ALICE);
        assertLe(out, deposit + 1, "lag inside the fees paid out");
    }

    function testMintGuardBounds() public {
        vm.expectRevert(OracleNv2.InvalidMintGuards.selector);
        n.setMintGuards(59, 1 ether);
        vm.expectRevert(OracleNv2.InvalidMintGuards.selector);
        n.setMintGuards(1 days + 1, 1 ether);
        vm.expectRevert(OracleNv2.InvalidMintGuards.selector);
        n.setMintGuards(10 minutes, 0);
        vm.prank(STRANGER);
        vm.expectRevert();
        n.setMintGuards(10 minutes, 1 ether);
        assertEq(n.mintMaxPriceAge(), 90 minutes, "default age");
        assertEq(n.mintLimitPerWindow(), type(uint96).max, "unlimited until set");
    }

    // ---------------------------------------------------------------- fuzz

    /// Redeeming never pays more than the oracle value or the fair share, and never lowers the
    /// backing of the N that stays.
    function testFuzzRedeemNeverOverpays(uint256 rawA, uint256 rawB, uint256 rawPrice, uint256 rawRedeem) public {
        _mint(n, ALICE, bound(rawA, 0.001 ether, 1_000 ether));
        _mint(n, BOB, bound(rawB, 0.001 ether, 1_000 ether));
        uint256 price = bound(rawPrice, 1 ether, 1_000 ether);
        oracle.setPrice(price);
        uint256 amount = bound(rawRedeem, 1, n.balanceOf(ALICE));

        uint256 supplyBefore = n.totalSupply();
        uint256 collateralBefore = n.totalCollateralWei();
        uint256 out = n.quoteRedeem(amount);
        assertLe(out, amount * 1e18 / price, "above oracle value");
        assertLe(out, amount * collateralBefore / supplyBefore, "above fair share");
        if (out == 0) return;

        vm.prank(ALICE);
        n.redeemAtOracle(amount, out, ALICE);
        uint256 supplyAfter = n.totalSupply();
        uint256 collateralAfter = n.totalCollateralWei();
        assertGe(collateralAfter * supplyBefore, collateralBefore * supplyAfter, "remaining backing fell");
    }

    function testFuzzSurplusKeepsTheFloor(uint256 rawDeposit, uint256 rawPrice) public {
        n.setSurplusRecipients(STAKING, TREASURY, 2_000);
        _mint(n, ALICE, bound(rawDeposit, 0.001 ether, 1_000 ether));
        oracle.setPrice(bound(rawPrice, PRICE, 100_000 ether));
        (uint256 capacity, bool ready) = n.surplusMintCapacity();
        if (!ready) return;

        uint256 supplyBefore = n.totalSupply();
        uint256 released = n.releaseSurplus();
        assertEq(released, capacity, "capacity");
        assertLe(released, supplyBefore / 10, "more than one step");
        assertGe(released + 1, supplyBefore / 10, "above the trigger a release is the whole step");
        assertGe(n.backingRatioWad(), 3e18, "below 3.0x");
        assertEq(n.balanceOf(STAKING) + n.balanceOf(TREASURY), released, "split loses N");
        assertLe(n.balanceOf(TREASURY), released / 5, "treasury above 20%");
    }
}
