// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {TestBase} from "../TestBase.sol";
import {OracleNUSDv2} from "../../src/nusd/OracleNUSDv2.sol";
import {IPriceOracle} from "../../src/oracle/IPriceOracle.sol";
import {OracleRouter} from "../../src/oracle/OracleRouter.sol";
import {DIAOracleAdapter} from "../../src/oracle/DIAOracleAdapter.sol";
import {MockPriceOracle} from "../mocks/TokenomicsMocks.sol";
import {MockDIAFeed} from "../mocks/MockDIAFeed.sol";
import {GasBurningFeed} from "./mocks/GasBurningFeed.sol";

/// Tests for finding A-01 of the 2026-11 audit (docs/AUDIT_2026-11.md).
///
/// As audited, an oracle failure report never expired. One brief outage started the 7-day clock; if
/// nobody called clearOracleFailure, any later brief outage opened the price-free exit although the
/// oracle had worked in between. The exit pays a proportional share of the reserve, so with the
/// reserve at 2.5x an attacker who had minted 90,000 NUSD at $1 left with 414 zkLTC for the 360
/// deposited, and the other holder's backing stayed at 1.15x instead of returning to 2.5x.
///
/// The report is now void as soon as NUSD itself finds the oracle pricing: on a mint, a redemption,
/// a surplus release or any transfer of NUSD. A first version of the fix also trusted a timestamp
/// reported by the feed; the review showed that it could keep the exit shut for good and did not
/// cover a round the adapter cannot use, so it was removed.
///
/// What is left, and tested below as accepted: seven days in which no NUSD is minted, redeemed or
/// moved at all, between two outages.
contract AuditNUSDTest is TestBase {
    address private constant HOLDER = address(0xA11CE);
    address private constant ATTACKER = address(0xBAD);
    address private constant FRIEND = address(0xF21E4D);

    uint8 private constant LATE = 0; // no new round for longer than the adapter accepts
    uint8 private constant ZERO_ANSWER = 1;
    uint8 private constant ABOVE_BOUNDS = 2;
    uint8 private constant INCOMPLETE = 3;
    uint8 private constant STAMPED_AHEAD = 4; // a good price stamped one second ahead of the block
    uint8 private constant KINDS = 5;

    MockDIAFeed private feed;
    OracleRouter private router;
    OracleNUSDv2 private nusd;
    uint80 private round;

    function setUp() public {
        vm.warp(1_000_000);
        vm.deal(HOLDER, 1_000 ether);
        vm.deal(ATTACKER, 1_000 ether);
        vm.deal(address(this), 1_000 ether);
    }

    function _post(int256 answer) private {
        ++round;
        feed.setRound(round, answer, vm.getBlockTimestamp(), round);
    }

    /// The position of the finding behind the real adapter and router: the holder has 10,000 NUSD
    /// backed 2.5x, then the attacker mints 90,000 NUSD at $1 (1.15x). The mint comes before any
    /// report, so it clears nothing.
    function _stagePosition() private returns (uint256 attackerNusd) {
        round = 0;
        vm.deal(HOLDER, 1_000 ether);
        vm.deal(ATTACKER, 1_000 ether);
        feed = new MockDIAFeed(8);
        _post(100e8);
        DIAOracleAdapter adapter = new DIAOracleAdapter(address(feed), "Mock LTC/USD", 1 hours, 10 ether, 1_000 ether);
        router = new OracleRouter("LTC/USD", address(adapter), address(this));
        nusd = new OracleNUSDv2(IPriceOracle(address(router)), address(this), 1_000_000 ether);

        vm.prank(HOLDER);
        nusd.mintAtOracle{value: 100 ether}(0, HOLDER); // 10,000 NUSD
        vm.warp(vm.getBlockTimestamp() + 10 minutes);
        _post(250e8); // zkLTC rises: the same reserve backs 2.5x
        vm.prank(ATTACKER);
        attackerNusd = nusd.mintAtOracle{value: 360 ether}(0, ATTACKER);
        assertEq(attackerNusd, 90_000 ether, "360 zkLTC at $250");
        assertEq(nusd.backingRatioWad(), 1.15 ether, "diluted to 1.15x, as any mint at $1 does");
    }

    /// Makes the oracle unusable for this block in the chosen way.
    function _blip(uint8 kind) private {
        uint256 nowTime = vm.getBlockTimestamp();
        if (kind == LATE) {
            vm.warp(nowTime + 61 minutes);
        } else {
            ++round;
            if (kind == ZERO_ANSWER) feed.setRound(round, 0, nowTime, round);
            else if (kind == ABOVE_BOUNDS) feed.setRound(round, 1_001e8, nowTime, round);
            else if (kind == INCOMPLETE) feed.setRound(round, 250e8, nowTime, round - 1);
            else feed.setRound(round, 250e8, nowTime + 61, round); // past the adapter skew of a minute
        }
        assertFalse(router.isFresh(), "the oracle cannot price in this block");
    }

    /// The feed prices every hour for 170 hours (seven days and two hours).
    function _healthyWeek(bool holderMovesNusd) private {
        for (uint256 hour; hour < 170; ++hour) {
            vm.warp(vm.getBlockTimestamp() + 1 hours);
            _post(250e8);
            if (holderMovesNusd && hour == 100) {
                vm.prank(HOLDER);
                nusd.transfer(FRIEND, 1 ether);
            }
        }
        assertTrue(router.isFresh(), "the oracle prices right now");
    }

    /// The attack, for every way the second outage can look: report at a first outage, a week in
    /// which the oracle works and one holder sends 1 NUSD to a friend, then a second outage.
    function testAudit_A01_anyTransferOfNusdVoidsTheReport() public {
        for (uint8 kind; kind < KINDS; ++kind) {
            uint256 attackerNusd = _stagePosition();
            _blip(LATE);
            vm.prank(ATTACKER);
            nusd.reportOracleFailure();

            _healthyWeek(true);
            assertEq(nusd.oracleFailureReportedAt(), 0, "the transfer found the oracle pricing");

            _blip(kind);
            vm.prank(ATTACKER);
            vm.expectRevert(OracleNUSDv2.OracleFailureNotReported.selector);
            nusd.emergencyRedeem(attackerNusd, 0, ATTACKER);

            // Reporting again only starts a new seven days.
            vm.prank(ATTACKER);
            nusd.reportOracleFailure();
            uint256 exitAt = vm.getBlockTimestamp() + 7 days;
            assertEq(nusd.oracleFailureExitAt(), exitAt, "seven days from the new report");
            vm.prank(ATTACKER);
            vm.expectRevert(abi.encodeWithSelector(OracleNUSDv2.OracleFailureGracePending.selector, exitAt));
            nusd.emergencyRedeem(attackerNusd, 0, ATTACKER);
        }
    }

    /// A report made in each of those ways is voided the same way.
    function testAudit_A01_reportsOfEveryKindAreVoidedByATransfer() public {
        for (uint8 kind; kind < KINDS; ++kind) {
            _stagePosition();
            _blip(kind);
            vm.prank(ATTACKER);
            nusd.reportOracleFailure();
            assertGt(nusd.oracleFailureReportedAt(), 0, "reported");

            vm.warp(vm.getBlockTimestamp() + 1 hours);
            _post(250e8);
            vm.prank(ATTACKER);
            nusd.transfer(FRIEND, 1); // even the attacker moving 1 wei of his own NUSD
            assertEq(nusd.oracleFailureReportedAt(), 0, "void");
        }
    }

    /// A mint is a priced call: an attacker who mints after reporting clears his own report.
    function testAudit_A01_mintClearsAStaleFailureReport() public {
        MockPriceOracle oracle = new MockPriceOracle(100 ether);
        nusd = new OracleNUSDv2(IPriceOracle(address(oracle)), address(this), 1_000_000 ether);
        vm.prank(HOLDER);
        nusd.mintAtOracle{value: 100 ether}(0, HOLDER);
        oracle.setPrice(250 ether);

        oracle.setBroken(true);
        vm.prank(ATTACKER);
        nusd.reportOracleFailure();
        vm.warp(vm.getBlockTimestamp() + 1 minutes);
        oracle.setBroken(false);

        vm.warp(vm.getBlockTimestamp() + 6 days);
        vm.prank(ATTACKER);
        uint256 minted = nusd.mintAtOracle{value: 360 ether}(0, ATTACKER);
        assertEq(nusd.oracleFailureReportedAt(), 0, "a mint proves the oracle works, so the report is gone");

        vm.warp(vm.getBlockTimestamp() + 2 days);
        oracle.setBroken(true);
        vm.prank(ATTACKER);
        vm.expectRevert(OracleNUSDv2.OracleFailureNotReported.selector);
        nusd.emergencyRedeem(minted, 0, ATTACKER);
    }

    /// A redemption and a surplus release are priced calls too.
    function testAudit_A01_redeemAndSurplusReleaseClearTheReport() public {
        MockPriceOracle oracle = new MockPriceOracle(100 ether);
        nusd = new OracleNUSDv2(IPriceOracle(address(oracle)), address(this), 1_000_000 ether);
        nusd.setSurplusRecipients(address(0x57A6), address(0x7EA5), 2_000);
        vm.prank(HOLDER);
        nusd.mintAtOracle{value: 10 ether}(0, HOLDER);

        oracle.setBroken(true);
        nusd.reportOracleFailure();
        oracle.setBroken(false);
        vm.prank(HOLDER);
        nusd.redeemAtOracle(1 ether, 0, HOLDER);
        assertEq(nusd.oracleFailureReportedAt(), 0, "cleared by the redemption");

        oracle.setBroken(true);
        nusd.reportOracleFailure();
        oracle.setBroken(false);
        vm.warp(vm.getBlockTimestamp() + 14 days); // past the window that remembers the redemption
        oracle.setPrice(400 ether); // 4.0x: a release is due
        nusd.releaseSurplus();
        assertEq(nusd.oracleFailureReportedAt(), 0, "cleared by the surplus release");
    }

    /// A real outage is not affected: NUSD that moves while the oracle is down voids nothing, and
    /// the exit opens seven days after the report at the fair share.
    function testAudit_A01_transfersDuringTheOutageLeaveTheReportStanding() public {
        uint256 attackerNusd = _stagePosition();
        _blip(LATE);
        nusd.reportOracleFailure();
        uint256 reportedAt = vm.getBlockTimestamp();

        vm.prank(HOLDER);
        nusd.transfer(FRIEND, 1_000 ether);
        vm.warp(reportedAt + 3 days);
        vm.prank(FRIEND);
        nusd.transfer(HOLDER, 1_000 ether);
        assertEq(nusd.oracleFailureReportedAt(), reportedAt, "the oracle never priced: the report stands");

        vm.warp(reportedAt + 7 days - 1);
        vm.prank(HOLDER);
        vm.expectRevert(abi.encodeWithSelector(OracleNUSDv2.OracleFailureGracePending.selector, reportedAt + 7 days));
        nusd.emergencyRedeem(10_000 ether, 0, HOLDER);

        vm.warp(reportedAt + 7 days);
        vm.prank(HOLDER);
        assertEq(nusd.emergencyRedeem(10_000 ether, 0, HOLDER), 46 ether, "a tenth of the supply, a tenth of 460 zkLTC");
        vm.prank(ATTACKER);
        assertEq(nusd.emergencyRedeem(attackerNusd, 0, ATTACKER), 414 ether, "the order does not matter");
    }

    /// A feed that keeps delivering rounds the adapter can never use (each arrives already older
    /// than the adapter accepts) is a dead oracle for NUSD. The first version of the fix let every
    /// such delivery push the exit a week further; it now opens seven days after the report.
    function testAudit_A01_feedThatNeverPricesAgainOpensTheExitOnDaySeven() public {
        _stagePosition();
        _blip(LATE);
        nusd.reportOracleFailure();
        uint256 reportedAt = vm.getBlockTimestamp();

        for (uint256 delivery; delivery < 28; ++delivery) {
            vm.warp(vm.getBlockTimestamp() + 6 hours);
            ++round;
            feed.setRound(round, 250e8, vm.getBlockTimestamp() - 2 hours, round); // stamped 2 hours back
            assertFalse(router.isFresh(), "never usable, not even in the block it lands");
        }
        assertEq(vm.getBlockTimestamp(), reportedAt + 7 days, "seven days of deliveries");
        assertEq(nusd.oracleFailureExitAt(), reportedAt + 7 days, "the exit time did not move");
        vm.prank(HOLDER);
        assertEq(nusd.emergencyRedeem(10_000 ether, 0, HOLDER), 46 ether, "open");
    }

    /// A broken oracle that burns the gas of a read instead of reverting cannot make NUSD
    /// unaffordable to move while a report stands: the check a transfer makes has a gas ceiling.
    function testAudit_A01_brokenOracleCannotMakeTransfersUnaffordable() public {
        GasBurningFeed burner = new GasBurningFeed();
        DIAOracleAdapter adapter =
            new DIAOracleAdapter(address(burner), "Mock LTC/USD", 1 hours, 10 ether, 1_000 ether);
        router = new OracleRouter("LTC/USD", address(adapter), address(this));
        nusd = new OracleNUSDv2(IPriceOracle(address(router)), address(this), 1_000_000 ether);
        vm.prank(HOLDER);
        uint256 held = nusd.mintAtOracle{value: 10 ether}(0, HOLDER);

        burner.setBurning(true);
        nusd.reportOracleFailure();
        uint256 reportedAt = vm.getBlockTimestamp();

        vm.prank(HOLDER);
        (bool moved,) = address(nusd).call{gas: 400_000}(abi.encodeCall(nusd.transfer, (FRIEND, 1 ether)));
        assertTrue(moved, "a transfer fits in 400,000 gas although every oracle read burns what it is given");
        assertEq(nusd.balanceOf(FRIEND), 1 ether, "moved");
        assertEq(nusd.oracleFailureReportedAt(), reportedAt, "and the report stands");

        // What it costs does not grow with the gas the sender allows: without the ceiling the read
        // would burn nearly all of these three million.
        vm.prank(HOLDER);
        uint256 gasBefore = gasleft();
        (moved,) = address(nusd).call{gas: 3_000_000}(abi.encodeCall(nusd.transfer, (FRIEND, 1 ether)));
        uint256 gasUsed = gasBefore - gasleft();
        assertTrue(moved, "moved again");
        assertLe(gasUsed, 300_000, "the read is capped at ORACLE_PROBE_GAS whatever the sender allows");
        assertGt(gasUsed, 150_000, "and the broken read did burn nearly all of its allowance");

        vm.warp(reportedAt + 7 days);
        vm.prank(HOLDER);
        (bool exited,) =
            address(nusd).call{gas: 1_500_000}(abi.encodeCall(nusd.emergencyRedeem, (held - 2 ether, 0, HOLDER)));
        assertTrue(exited, "the exit makes one oracle read and fits in 1.5M gas");
    }

    /// A report made while one already stands changes nothing. If it restarted the seven days,
    /// anyone could keep the exit shut through a real outage by reporting again every week.
    function testAudit_A01_aSecondReportDoesNotRestartTheClock() public {
        _stagePosition();
        _blip(LATE);
        nusd.reportOracleFailure();
        uint256 reportedAt = vm.getBlockTimestamp();

        vm.warp(reportedAt + 3 days);
        vm.prank(ATTACKER);
        nusd.reportOracleFailure();
        assertEq(nusd.oracleFailureReportedAt(), reportedAt, "the first report stands");
        assertEq(nusd.oracleFailureExitAt(), reportedAt + 7 days, "and so does the day the exit opens");

        vm.warp(reportedAt + 7 days);
        vm.prank(HOLDER);
        assertEq(nusd.emergencyRedeem(10_000 ether, 0, HOLDER), 46 ether, "open seven days after the first report");
    }

    /// Accepted, and stated in the report: if no NUSD at all is minted, redeemed or moved for seven
    /// days after a report and nobody calls clearOracleFailure, a second outage still opens the
    /// exit, with the outcome of the original finding. Any single transfer in that week prevents it.
    function testAudit_A01_accepted_aWeekWithoutAnyNusdActivityStillOpensTheExit() public {
        uint256 attackerNusd = _stagePosition();
        _blip(LATE);
        vm.prank(ATTACKER);
        nusd.reportOracleFailure();

        _healthyWeek(false); // the oracle works; nobody touches NUSD
        _blip(ZERO_ANSWER);
        vm.prank(ATTACKER);
        assertEq(nusd.emergencyRedeem(attackerNusd, 0, ATTACKER), 414 ether, "414 zkLTC for the 360 deposited");
    }
}
