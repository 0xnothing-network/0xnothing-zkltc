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
        nusd.setFees(201, 0);
        vm.expectRevert(OracleNUSDv2.InvalidFee.selector);
        nusd.setFees(0, 201);
        nusd.setFees(200, 200);
        assertEq(nusd.mintFeeBps(), 200, "fees reach 2% for coarse feeds");
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

        // Far above the trigger a release is still one step: what a release exactly at the trigger
        // mints, a tenth of the supply. The rest follows a week at a time.
        vm.warp(nextAt);
        (capacity,) = nusd.surplusMintCapacity();
        assertEq(capacity, 11 ether, "a tenth of 110 NUSD, not the 223.33 that 9.09x has room for");
        assertEq(nusd.releaseSurplus(), 11 ether, "one step");
        assertEq(nusd.balanceOf(STAKING), 8 ether + 8.8 ether, "80% of it to stakers");
        vm.warp(nextAt + 7 days);
        assertEq(nusd.releaseSurplus(), 12.1 ether, "the next step a week later, on the larger supply");
        assertEq(nusd.totalSupply(), 133.1 ether, "100 + 10 + 11 + 12.1");
        assertGe(nusd.backingRatioWad(), 3e18, "never below the floor");
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

        // A zero treasury share sends everything to the stakers. The step follows the two ratios:
        // at 2.1x over 2.0x a release mints a twentieth of the supply.
        nusd.setSurplusRecipients(STAKING, TREASURY, 0);
        nusd.releaseSurplus();
        assertEq(nusd.balanceOf(TREASURY), 0, "no treasury share");
        assertEq(nusd.balanceOf(STAKING), 5 ether, "one step of 100 NUSD at 2.1x over 2.0x");
    }

    /// A release is never cut down to what the ceiling has room for: it waits until all of it
    /// fits, and it lifts the ceiling when a mint of one wei would.
    function testSurplusWaitsForRoomUnderTheSupplyCeiling() public {
        OracleNUSDv2 token = _deploy(105 ether);
        token.setSurplusRecipients(STAKING, TREASURY, 2_000);
        _mint(token, ALICE, 1 ether); // 100 NUSD, ceiling raised to 210 by the 80% rule
        assertEq(token.supplyCeilingNusd(), 210 ether, "auto-raised");
        token.setSupplyCeiling(105 ether);

        oracle.setPrice(1_000 ether);
        (uint256 capacity, bool ready) = token.surplusMintCapacity();
        assertEq(capacity, 0, "the step of 10 does not fit in a headroom of 5");
        assertFalse(ready, "so nothing is released");
        vm.expectRevert(abi.encodeWithSelector(OracleNUSDv2.SurplusBelowTrigger.selector, 1_000 ether, 100 ether));
        token.releaseSurplus();
        assertEq(token.lastSurplusReleaseAt(), 0, "and the week is not used up");

        // The admin makes room for exactly one step: it goes out whole and fills the ceiling.
        token.setSupplyCeiling(110 ether);
        assertEq(token.releaseSurplus(), 10 ether, "the whole step once it fits exactly");
        assertEq(token.totalSupply(), 110 ether, "at the ceiling");
        assertEq(token.balanceOf(STAKING), 8 ether, "80%");
        assertEq(token.balanceOf(TREASURY), 2 ether, "20%");
        vm.prank(BOB);
        vm.expectRevert(abi.encodeWithSelector(OracleNUSDv2.SupplyCeilingExceeded.selector, 1_000 ether, 0));
        token.mintAtOracle{value: 1 ether}(0, BOB);

        // A week after the last raise the next release lifts the ceiling itself, as a mint would.
        vm.warp(vm.getBlockTimestamp() + 7 days);
        assertEq(token.releaseSurplus(), 11 ether, "a tenth of 110, with nobody minting first");
        assertEq(token.supplyCeilingNusd(), 220 ether, "doubled by the release");
        assertEq(token.lastCeilingRaiseAt(), vm.getBlockTimestamp(), "and counted as this week's raise");
    }

    function testSurplusCountsRedeemedSupplyForOneToTwoWeeks() public {
        nusd.setSurplusRecipients(STAKING, TREASURY, 2_000);
        _mint(nusd, ALICE, 1 ether); // 100 NUSD
        nusd.coverReserve{value: 2.2 ether}(); // $320 behind 100 NUSD: 3.2x, below the trigger
        assertEq(nusd.surplusSupplyBasis(), 100 ether, "no redemption yet: the supply itself");

        vm.prank(ALICE);
        nusd.redeemAtOracle(10 ether, 0, ALICE); // $310 behind 90 NUSD: 3.44x on the raw supply
        assertEq(nusd.surplusSupplyBasis(), 100 ether, "the supply the redemption started from");
        (, bool ready) = nusd.surplusMintCapacity();
        assertFalse(ready, "3.1x against the remembered 100 NUSD");
        vm.expectRevert(abi.encodeWithSelector(OracleNUSDv2.SurplusBelowTrigger.selector, 310 ether, 100 ether));
        nusd.releaseSurplus();

        // Epochs are whole weeks of chain time. Still remembered throughout the next one ...
        uint256 epoch = vm.getBlockTimestamp() / 7 days;
        vm.warp((epoch + 2) * 7 days - 1);
        assertEq(nusd.surplusSupplyBasis(), 100 ether, "remembered through the following epoch");
        // ... and forgotten the moment the one after it begins.
        vm.warp((epoch + 2) * 7 days);
        assertEq(nusd.surplusSupplyBasis(), 90 ether, "then only the real supply counts");
        assertEq(nusd.releaseSurplus(), 9 ether, "one step of the lasting supply (3.44x has room for 13.33)");
    }

    function testPlainBurnCountsTowardTheSurplusAtOnce() public {
        nusd.setSurplusRecipients(STAKING, TREASURY, 2_000);
        _mint(nusd, ALICE, 1 ether); // 100 NUSD
        nusd.coverReserve{value: 2.2 ether}(); // 3.2x

        // A burn leaves its collateral in the reserve, so it cannot be undone by minting back.
        vm.prank(ALICE);
        nusd.burn(4 ether);
        assertEq(nusd.surplusSupplyBasis(), 96 ether, "not remembered");
        assertEq(nusd.releaseSurplus(), 9.6 ether, "3.33x releases one step of the 96 NUSD left");
    }

    function testMintPauseAlsoStopsTheSurplusRelease() public {
        nusd.setSurplusRecipients(STAKING, TREASURY, 2_000);
        _mint(nusd, ALICE, 1 ether);
        oracle.setPrice(400 ether);
        nusd.setMintPaused(true);
        (, bool ready) = nusd.surplusMintCapacity();
        assertFalse(ready, "paused");
        vm.expectRevert(OracleNUSDv2.MintPaused.selector);
        nusd.releaseSurplus();

        nusd.setMintPaused(false);
        assertGt(nusd.releaseSurplus(), 0, "released once minting is open again");
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
        assertEq(nusd.oracleFailureExitAt(), 0, "no report, no exit time");
        oracle.setBroken(true);
        nusd.reportOracleFailure();
        assertEq(nusd.oracleFailureExitAt(), vm.getBlockTimestamp() + 7 days, "seven days from the report");
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

    function testEveryPricedCallClearsTheFailureReport() public {
        nusd.setSurplusRecipients(STAKING, TREASURY, 2_000);
        _mint(nusd, ALICE, 1 ether);

        oracle.setBroken(true);
        nusd.reportOracleFailure();
        oracle.setBroken(false);
        _mint(nusd, BOB, 1 ether);
        assertEq(nusd.oracleFailureReportedAt(), 0, "a mint");

        oracle.setBroken(true);
        nusd.reportOracleFailure();
        oracle.setBroken(false);
        vm.prank(ALICE);
        nusd.redeemAtOracle(1 ether, 0, ALICE);
        assertEq(nusd.oracleFailureReportedAt(), 0, "a redemption");

        oracle.setBroken(true);
        nusd.reportOracleFailure();
        oracle.setBroken(false);
        vm.warp(vm.getBlockTimestamp() + 14 days);
        oracle.setPrice(1_000 ether);
        nusd.releaseSurplus();
        assertEq(nusd.oracleFailureReportedAt(), 0, "a surplus release");
    }

    function testATransferVoidsAReportOnlyWhileTheOraclePrices() public {
        _mint(nusd, ALICE, 1 ether);
        oracle.setBroken(true);
        nusd.reportOracleFailure();
        uint256 reportedAt = vm.getBlockTimestamp();

        vm.prank(ALICE);
        nusd.transfer(BOB, 10 ether);
        assertEq(nusd.oracleFailureReportedAt(), reportedAt, "the oracle is down: the report stands");

        oracle.setBroken(false);
        vm.prank(ALICE);
        nusd.approve(STRANGER, 5 ether);
        assertEq(nusd.oracleFailureReportedAt(), reportedAt, "an approval moves nothing");
        vm.prank(STRANGER);
        nusd.transferFrom(ALICE, BOB, 5 ether);
        assertEq(nusd.oracleFailureReportedAt(), 0, "NUSD moved while the oracle priced: the report is void");
        assertEq(nusd.balanceOf(BOB), 15 ether, "and the transfer itself is unaffected");

        // A price of zero is not a price.
        oracle.setBroken(true);
        nusd.reportOracleFailure();
        oracle.setBroken(false);
        oracle.setPrice(0);
        vm.prank(BOB);
        nusd.transfer(ALICE, 1 ether);
        assertGt(nusd.oracleFailureReportedAt(), 0, "a zero price leaves the report standing");
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

    // ---------------------------------------------------------------- oracle-lag guards

    function testMintNeedsAFreshPrice() public {
        nusd.setMintGuards(10 minutes, 1_000_000 ether);
        oracle.setUpdatedAt(vm.getBlockTimestamp() - 11 minutes);
        vm.prank(ALICE);
        vm.expectRevert(
            abi.encodeWithSelector(OracleNUSDv2.StaleMintPrice.selector, vm.getBlockTimestamp() - 11 minutes, 10 minutes)
        );
        nusd.mintAtOracle{value: 1 ether}(0, ALICE);

        oracle.setUpdatedAt(vm.getBlockTimestamp() - 10 minutes);
        assertEq(_mint(nusd, ALICE, 1 ether), 100 ether, "fresh enough");

        // Redemption never waits for a fresher price; against an old one it pays the maximum fee.
        nusd.setFees(0, 50);
        assertEq(nusd.quoteRedeem(100 ether), 0.995 ether, "fresh: the 0.5% redeem fee");
        oracle.setUpdatedAt(vm.getBlockTimestamp() - 10 minutes - 1);
        assertEq(nusd.quoteRedeem(100 ether), 0.98 ether, "one second too old to mint against: 2%");
        vm.prank(ALICE);
        assertEq(nusd.redeemAtOracle(100 ether, 0, ALICE), 0.98 ether, "redeem stays open");
        assertEq(nusd.totalCollateralWei(), 0.02 ether, "and the fee stays in the reserve");
    }

    function testSurplusReleaseNeedsAFreshPriceToo() public {
        nusd.setSurplusRecipients(STAKING, TREASURY, 2_000);
        nusd.setMintGuards(10 minutes, 1_000_000 ether);
        _mint(nusd, ALICE, 1 ether);
        oracle.setPrice(1_000 ether);
        oracle.setUpdatedAt(vm.getBlockTimestamp() - 1 hours);
        vm.expectRevert(
            abi.encodeWithSelector(OracleNUSDv2.StaleMintPrice.selector, vm.getBlockTimestamp() - 1 hours, 10 minutes)
        );
        nusd.releaseSurplus();
    }

    function testMintBudgetRefillsOverAnHour() public {
        nusd.setMintGuards(90 minutes, 150 ether);
        _mint(nusd, ALICE, 1 ether);
        assertEq(nusd.mintAvailableInWindow(), 50 ether, "100 of 150 used");
        vm.prank(BOB);
        vm.expectRevert(abi.encodeWithSelector(OracleNUSDv2.MintRateLimited.selector, 100 ether, 50 ether));
        nusd.mintAtOracle{value: 1 ether}(0, BOB);
        _mint(nusd, BOB, 0.5 ether);
        assertEq(nusd.mintAvailableInWindow(), 0, "budget spent");

        vm.warp(vm.getBlockTimestamp() + 20 minutes);
        assertEq(nusd.mintAvailableInWindow(), 50 ether, "a third is back after a third of the hour");
        _mint(nusd, BOB, 0.5 ether);
        assertEq(nusd.mintAvailableInWindow(), 0, "and can be spent as it returns");

        vm.warp(vm.getBlockTimestamp() + 1 hours);
        assertEq(nusd.mintAvailableInWindow(), 150 ether, "whole again an hour after the last mint");
        _mint(nusd, BOB, 1 ether);
        assertEq(nusd.mintedInWindow(), 100 ether, "counted from an empty budget");

        // Lowering the limit below what is counted stops minting until it has drained.
        nusd.setMintGuards(90 minutes, 60 ether);
        assertEq(nusd.mintAvailableInWindow(), 0, "100 counted against a budget of 60");
        vm.warp(vm.getBlockTimestamp() + 50 minutes);
        assertEq(nusd.mintAvailableInWindow(), 10 ether, "50 of the 100 drained at the new rate");
    }

    /// With the reserve well above 1x (the designed state), a trade against a lagging price does
    /// not pay while the lag is within the fee of the leg it uses: the mint leg yields no more
    /// NUSD than the deposit is worth at the market, the redeem leg no more zkLTC than the NUSD is
    /// worth at the market. The lag is measured from the oracle price, like a feed's threshold.
    function testFuzzLagWithinTheFeeOfALegIsUnprofitable(uint256 rawFee, uint256 rawLag, uint256 rawDeposit) public {
        uint256 fee = bound(rawFee, 0, 200);
        uint256 lag = bound(rawLag, 0, fee);
        uint256 deposit = bound(rawDeposit, 0.01 ether, 100 ether);
        nusd.setFees(fee, fee);
        _mint(nusd, BOB, 300 ether);
        nusd.coverReserve{value: 600 ether}(); // about 3x: the pro-rata leg never caps a payout

        // Mint leg: the market is `lag` below the oracle.
        uint256 minted = _mint(nusd, ALICE, deposit);
        assertLe(minted, deposit * (PRICE * (10_000 - lag) / 10_000) / 1e18 + 1, "the mint leg paid");

        // Redeem leg: the market is `lag` above the oracle.
        vm.prank(ALICE);
        uint256 out = nusd.redeemAtOracle(minted, 0, ALICE);
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
        nusd.setFees(fee, fee);
        _mint(nusd, BOB, 300 ether);
        nusd.coverReserve{value: 600 ether}(); // about 3x, so nothing but the fees stands in the way
        uint256 minted = _mint(nusd, ALICE, deposit);
        oracle.setPrice(PRICE * (10_000 - drop) / 10_000);
        vm.prank(ALICE);
        uint256 out = nusd.redeemAtOracle(minted, 0, ALICE);
        assertLe(out, deposit + 1, "lag inside the fees paid out");
    }

    function testMintGuardBounds() public {
        vm.expectRevert(OracleNUSDv2.InvalidMintGuards.selector);
        nusd.setMintGuards(59, 1 ether);
        vm.expectRevert(OracleNUSDv2.InvalidMintGuards.selector);
        nusd.setMintGuards(1 days + 1, 1 ether);
        vm.expectRevert(OracleNUSDv2.InvalidMintGuards.selector);
        nusd.setMintGuards(10 minutes, 0);
        vm.prank(STRANGER);
        vm.expectRevert();
        nusd.setMintGuards(10 minutes, 1 ether);
        assertEq(nusd.mintMaxPriceAge(), 90 minutes, "default age");
        assertEq(nusd.mintLimitPerWindow(), type(uint96).max, "unlimited until set");
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

        uint256 supplyBefore = nusd.totalSupply();
        uint256 released = nusd.releaseSurplus();
        assertEq(released, capacity, "capacity");
        assertLe(released, supplyBefore / 10, "more than one step");
        assertGe(released + 1, supplyBefore / 10, "above the trigger a release is the whole step");
        assertGe(nusd.backingRatioWad(), 3e18, "below 3.0x");
        assertEq(nusd.balanceOf(STAKING) + nusd.balanceOf(TREASURY), released, "split loses NUSD");
        assertLe(nusd.balanceOf(TREASURY), released / 5, "treasury above 20%");
    }
}
