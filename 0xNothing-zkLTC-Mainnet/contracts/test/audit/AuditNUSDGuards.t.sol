// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {TestBase} from "../TestBase.sol";
import {OracleNUSDv2} from "../../src/nusd/OracleNUSDv2.sol";
import {IPriceOracle} from "../../src/oracle/IPriceOracle.sol";
import {OracleRouter} from "../../src/oracle/OracleRouter.sol";
import {DIAOracleAdapter} from "../../src/oracle/DIAOracleAdapter.sol";
import {MockPriceOracle} from "../mocks/TokenomicsMocks.sol";
import {MockDIAFeed} from "../mocks/MockDIAFeed.sol";

/// Tests for findings A-02 to A-07 of the 2026-11 audit of NUSD and the oracle router
/// (docs/AUDIT_2026-11.md). A-02, A-03, A-05 and A-07 were fixed: their tests replay the attack and
/// assert that it now fails. A-04 and A-06 are accepted and documented: their tests still pass on the
/// harmful outcome, so the numbers in the report stay measured and a later fix has to update them.
contract AuditNUSDGuardsTest is TestBase {
    uint256 private constant PRICE = 100 ether; // $100 per zkLTC

    address private constant HOLDER = address(0xA11CE);
    address private constant ATTACKER = address(0xBAD);
    address private constant BOB = address(0xB0B);
    address private constant STAKING = address(0x57A6);
    address private constant TREASURY = address(0x7EA5);
    address private constant STRANGER = address(0x5757);

    MockPriceOracle private oracle;
    OracleNUSDv2 private nusd;

    function setUp() public {
        vm.warp(1_000_000);
        vm.deal(HOLDER, 1_000_000 ether);
        vm.deal(ATTACKER, 1_000_000 ether);
        vm.deal(BOB, 1_000_000 ether);
        vm.deal(address(this), 1_000_000 ether);
    }

    function _deploy(uint256 ceiling) private {
        oracle = new MockPriceOracle(PRICE);
        nusd = new OracleNUSDv2(IPriceOracle(address(oracle)), address(this), ceiling);
    }

    function _mint(address account, uint256 collateralWei) private returns (uint256 amount) {
        vm.prank(account);
        amount = nusd.mintAtOracle{value: collateralWei}(0, account);
    }

    function _redeem(address account, uint256 amountNusd) private returns (uint256 out) {
        vm.prank(account);
        out = nusd.redeemAtOracle(amountNusd, 0, account);
    }

    /// A-02 (fixed): the surplus trigger read the supply of that instant, so a large holder could
    /// redeem, force a release that was not due, and mint back: 132,832.5 NUSD were minted against
    /// an unchanged reserve and 3.2x became 2.8256x, below the 3.0x floor, for 992.5 NUSD of fees.
    /// The release is now measured against the highest supply a redemption started from in this
    /// 7-day epoch or the last, so the redemption does not move the ratio the release sees.
    function testAudit_A02_redeemNoLongerForcesASurplusRelease() public {
        _deploy(10_000_000 ether);
        nusd.setFees(50, 50);
        nusd.setSurplusRecipients(STAKING, TREASURY, 2_000);
        _mint(HOLDER, 9_000 ether); // 895,500 NUSD
        uint256 whaleNusd = _mint(ATTACKER, 1_000 ether); // 99,500 NUSD, 10% of supply
        nusd.coverReserve{value: 21_840 ether}(); // reserve 31,840 zkLTC = $3,184,000
        assertEq(nusd.totalSupply(), 995_000 ether, "supply");
        assertEq(nusd.backingRatioWad(), 3.2 ether, "3.2x: above the floor, below the 3.3x trigger");

        // 1. Redeem: the raw ratio passes the trigger, the basis of the release does not move.
        uint256 zkOut = _redeem(ATTACKER, whaleNusd);
        assertEq(zkOut, 990.025 ether, "995 zkLTC minus the 0.5% fee");
        assertGe(nusd.backingRatioWad(), 3.3 ether, "the raw ratio is above the trigger");
        assertEq(nusd.surplusSupplyBasis(), 995_000 ether, "the redeemed NUSD still counts");
        (, bool ready) = nusd.surplusMintCapacity();
        assertFalse(ready, "no release is due");

        // 2. The release she wanted reverts.
        vm.prank(ATTACKER);
        vm.expectRevert(
            abi.encodeWithSelector(OracleNUSDv2.SurplusBelowTrigger.selector, 3_084_997.5 ether, 995_000 ether)
        );
        nusd.releaseSurplus();

        // 3. Minting back leaves her two fees poorer and the reserve ratio higher than before.
        uint256 mintedBack = _mint(ATTACKER, zkOut);
        assertEq(whaleNusd - mintedBack, 992.5125 ether, "the whole outcome: two fees paid to the reserve");
        assertEq(nusd.balanceOf(STAKING) + nusd.balanceOf(TREASURY), 0, "nothing was released");
        assertGt(nusd.backingRatioWad(), 3.2 ether, "backing went up, not down");

        // A reduction that lasts earns its release once the window has passed, one step at a time.
        _redeem(ATTACKER, mintedBack);
        vm.warp(vm.getBlockTimestamp() + 14 days);
        assertEq(nusd.surplusSupplyBasis(), 895_500 ether, "two epochs on, only the real supply counts");
        assertEq(nusd.releaseSurplus(), 89_550 ether, "a tenth of the lasting supply");
        assertGe(nusd.backingRatioWad(), 3 ether, "and the release stays above the floor");
    }

    /// A-02 (accepted limit of the fix): the fix delays the move and bounds it, it does not remove
    /// it. A redemption in the last second of a 7-day epoch is remembered for 7 days and 1 second.
    /// After that wait a release is forced. Since the second review one release is one step, a
    /// tenth of the supply left: 89,550 NUSD where the audit measured 132,832.5, and 2.9385x after
    /// she mints back where it measured 2.8256x, for the same 992.5125 NUSD of fees. She must stay
    /// out of NUSD for at least a week, every time.
    function testAudit_A02_accepted_redemptionThatStaysOutAWeekStillForcesTheRelease() public {
        _deploy(10_000_000 ether);
        nusd.setFees(50, 50);
        nusd.setSurplusRecipients(STAKING, TREASURY, 2_000);
        _mint(HOLDER, 9_000 ether); // 895,500 NUSD
        uint256 whaleNusd = _mint(ATTACKER, 1_000 ether); // 99,500 NUSD
        nusd.coverReserve{value: 21_840 ether}(); // 31,840 zkLTC = $3,184,000
        assertEq(nusd.backingRatioWad(), 3.2 ether, "3.2x: no release is due");

        // The last second of the current epoch.
        vm.warp((vm.getBlockTimestamp() / 7 days + 1) * 7 days - 1);
        uint256 zkOut = _redeem(ATTACKER, whaleNusd);
        uint256 redeemedAt = vm.getBlockTimestamp();
        assertEq(nusd.surplusSupplyBasis(), 995_000 ether, "remembered");

        vm.warp(redeemedAt + 7 days);
        assertEq(nusd.surplusSupplyBasis(), 995_000 ether, "remembered for exactly seven days");

        vm.warp(redeemedAt + 7 days + 1);
        assertEq(nusd.surplusSupplyBasis(), 895_500 ether, "forgotten one second later");
        (uint256 capacity,) = nusd.surplusMintCapacity();
        assertEq(capacity, 89_550 ether, "one step, where 3.445x has room for the 132,832.5 the audit measured");
        vm.prank(ATTACKER);
        assertEq(nusd.releaseSurplus(), 89_550 ether, "a tenth of the 895,500 NUSD left");

        uint256 mintedBack = _mint(ATTACKER, zkOut);
        assertEq(whaleNusd - mintedBack, 992.5125 ether, "her whole cost: the two fees");
        assertEq(nusd.totalCollateralWei(), 31_840 ether, "same reserve as before she started");
        assertEq(nusd.totalSupply(), 995_000 ether + 89_550 ether - 992.5125 ether, "supply up by the release");
        assertApproxEq(nusd.backingRatioWad(), 2.9385 ether, 0.0001 ether, "2.9385x where the audit ended at 2.8256x");
    }

    /// A-02 (accepted limit of the fix): a redemption records the supply it starts from, however
    /// briefly that supply existed. One mint and redeem of 1.6% of supply per week (cost: the two fees, $159.60)
    /// keeps the release that is due at 3.35x (one step, 100,000 NUSD) blocked for as long as it is repeated.
    function testAudit_A02_accepted_weeklyRoundTripKeepsADueReleaseBlocked() public {
        _deploy(10_000_000 ether);
        nusd.setSurplusRecipients(STAKING, TREASURY, 2_000);
        _mint(HOLDER, 10_000 ether); // 1,000,000 NUSD, minted before the fees are set
        nusd.setFees(50, 50);
        nusd.coverReserve{value: 23_500 ether}(); // 33,500 zkLTC = $3,350,000: 3.35x
        (uint256 due, bool ready) = nusd.surplusMintCapacity();
        assertTrue(ready, "a release is due");
        assertEq(due, 100_000 ether, "one step: a tenth of the supply");

        uint256 cost;
        for (uint256 week; week < 8; ++week) {
            uint256 balanceBefore = BOB.balance;
            uint256 minted = _mint(BOB, 160 ether); // 15,920 NUSD
            _redeem(BOB, minted); // in the same block
            cost += balanceBefore - BOB.balance;
            assertEq(nusd.totalSupply(), 1_000_000 ether, "the real supply did not change");
            assertEq(nusd.surplusSupplyBasis(), 1_015_920 ether, "but the release is measured against more");
            (, ready) = nusd.surplusMintCapacity();
            assertFalse(ready, "blocked");
            vm.expectRevert();
            nusd.releaseSurplus();

            vm.warp(vm.getBlockTimestamp() + 7 days);
            (, ready) = nusd.surplusMintCapacity();
            assertFalse(ready, "still blocked a week later, before the next round trip");
        }
        assertEq(cost, 8 * 1.596 ether, "1.596 zkLTC ($159.60) per week");
        assertEq(nusd.balanceOf(STAKING) + nusd.balanceOf(TREASURY), 0, "eight weeks without the release that was due");

        // It ends when the griefer stops: one more week and the memory lapses.
        vm.warp(vm.getBlockTimestamp() + 7 days);
        assertEq(nusd.releaseSurplus(), 100_000 ether, "released at last");
    }

    /// A-03 (a) (rule corrected): a trade against a lagging price pays whenever the lag is larger
    /// than the fee on that leg. The deployment guidance said each fee could be half the feed's
    /// deviation threshold; with 0.5% + 0.5% and a 1.5% move the round trip took 0.51 zkLTC per
    /// 100. The rule is now one fee per leg, each at or above the threshold, and the deploy script
    /// enforces it. With both fees at the size of the move, neither leg nor the round trip pays.
    function testAudit_A03_lagWithinTheFeeDoesNotPay() public {
        _deploy(10_000_000 ether);
        nusd.setFees(150, 150); // the feed's deviation threshold: 1.5%
        _mint(HOLDER, 1_000 ether);
        nusd.coverReserve{value: 2_000 ether}(); // about 3x, so the pro-rata leg never caps a payout

        // Mint leg: the oracle still says $100 while the market is 1.5% lower.
        uint256 minted = _mint(ATTACKER, 100 ether);
        assertEq(minted, 9_850 ether, "100 zkLTC at the lagging $100 minus 1.5%");
        assertLe(minted, 100 * 98.5 ether, "worth no more than the $9,850 the zkLTC was worth");

        // Round trip: the update lands and she redeems.
        oracle.setPrice(98.5 ether);
        uint256 out = _redeem(ATTACKER, minted);
        assertLe(out, 100 ether, "less zkLTC back than deposited");

        // Redeem leg: the oracle says $98.50 while the market is 1.5% higher ($99.9775).
        uint256 held = _mint(ATTACKER, 100 ether);
        uint256 fair = held * 1 ether / 99.9775 ether;
        assertLe(_redeem(ATTACKER, held), fair, "no more zkLTC than the NUSD is worth at the market");
    }

    /// A-03 (b) (reduced): redemption has no price-age limit, by design: it must never be blocked.
    /// Behind an adapter that accepts a 6 hour old round, a redemption against a 2 hour old $100
    /// while the market was at $103 followed by a mint at the new round gained 1.97%. A redemption
    /// against a price too old to mint against now pays the maximum fee (2%), which leaves 0.44%
    /// of that 3% move and nothing of a move up to 2.5%. What remains is bounded by the adapter's
    /// maximum age: keep it close to the mint age (config/mainnet.env.example).
    function testAudit_A03_staleRedeemPaysTheMaximumFee() public {
        MockDIAFeed feed = new MockDIAFeed(8);
        uint256 roundTime = vm.getBlockTimestamp();
        feed.setRound(1, 100e8, roundTime, 1);
        DIAOracleAdapter adapter = new DIAOracleAdapter(address(feed), "Mock LTC/USD", 6 hours, 10 ether, 1_000 ether);
        nusd = new OracleNUSDv2(IPriceOracle(address(adapter)), address(this), 10_000_000 ether);
        nusd.setFees(50, 50);
        _mint(HOLDER, 1_000 ether);
        nusd.coverReserve{value: 2_000 ether}();
        uint256 held = _mint(ATTACKER, 100 ether);
        assertEq(held, 9_950 ether, "attacker inventory");
        assertEq(nusd.quoteRedeem(held), 99.0025 ether, "fresh price: the 0.5% redeem fee");
        uint256 reserveBefore = nusd.totalCollateralWei();

        // Two hours without a round: inside the adapter's 6 hours, past the 90 minute mint limit.
        vm.warp(roundTime + 2 hours);
        vm.prank(ATTACKER);
        vm.expectRevert(abi.encodeWithSelector(OracleNUSDv2.StaleMintPrice.selector, roundTime, 90 minutes));
        nusd.mintAtOracle{value: 1 ether}(0, ATTACKER);

        // The redemption still goes through, at the stale $100 and the 2% fee.
        uint256 zkOut = _redeem(ATTACKER, held);
        assertEq(zkOut, 97.51 ether, "9,950 NUSD at the stale $100 minus 2%");

        // The round arrives at $103; mint back with what was redeemed.
        feed.setRound(2, 103e8, vm.getBlockTimestamp(), 2);
        uint256 mintedBack = _mint(ATTACKER, zkOut);
        assertApproxEq(mintedBack - held, 43.31 ether, 0.01 ether, "+0.44%, down from +1.97%");
        assertEq(nusd.totalCollateralWei(), reserveBefore, "same reserve");
        assertApproxEq(nusd.quoteRedeem(held), 96.1189 ether, 0.0001 ether, "fresh again: 9,950 / 103 minus 0.5%");
    }

    /// A-04 (accepted, operational): OracleRouter.setSource accepts a new live source up to 25% away from the current one,
    /// and the switch is one visible admin transaction. With the maximum 2% + 2% fees and a switch
    /// from $100 to $120, a holder who redeems 980 NUSD before the switch and mints back after it
    /// holds 1,129.4304 NUSD: +149.4304 NUSD (15.2%), against an unchanged reserve.
    function testAudit_A04_routerSwitchSandwich() public {
        MockPriceOracle sourceA = new MockPriceOracle(100 ether);
        MockPriceOracle sourceB = new MockPriceOracle(120 ether);
        OracleRouter router = new OracleRouter("LTC/USD", address(sourceA), address(this));
        nusd = new OracleNUSDv2(IPriceOracle(address(router)), address(this), 10_000_000 ether);
        nusd.setFees(200, 200);
        _mint(HOLDER, 1_000 ether);
        nusd.coverReserve{value: 2_000 ether}();
        uint256 held = _mint(ATTACKER, 10 ether);
        assertEq(held, 980 ether, "10 zkLTC at $100 minus 2%");
        uint256 reserveBefore = nusd.totalCollateralWei();
        uint256 supplyBefore = nusd.totalSupply();

        uint256 zkOut = _redeem(ATTACKER, held); // front-runs the queued switch
        assertEq(zkOut, 9.604 ether, "9.8 zkLTC minus 2%");

        router.setSource(address(sourceB)); // both sources live, 20% apart: accepted
        (uint256 priceNow,,) = router.readPriceWad();
        assertEq(priceNow, 120 ether, "the live price moved 20% in one transaction");

        uint256 mintedBack = _mint(ATTACKER, zkOut);
        assertEq(mintedBack, 1_129.4304 ether, "9.604 zkLTC at $120 minus 2%");
        assertEq(mintedBack - held, 149.4304 ether, "gain: 20% minus the two fees");
        assertEq(nusd.totalCollateralWei(), reserveBefore, "same reserve");
        assertEq(nusd.totalSupply() - supplyBefore, 149.4304 ether, "the gain is new NUSD on that reserve");
    }

    /// A-05 (fixed): the hourly mint budget was a fixed window, so 49,999 NUSD at the end of one
    /// window and 50,000 at the start of the next put twice the budget out within a second. The
    /// budget now refills evenly: a second after it was spent, a second's worth is back.
    function testAudit_A05_mintBudgetRefillsEvenly() public {
        _deploy(10_000_000 ether);
        uint256 limit = 50_000 ether;
        nusd.setMintGuards(90 minutes, limit);

        uint256 t0 = vm.getBlockTimestamp();
        assertEq(_mint(ATTACKER, 0.01 ether), 1 ether, "the dust mint that used to anchor the window");

        vm.warp(t0 + 3_599);
        assertEq(nusd.mintAvailableInWindow(), limit, "the dust has long refilled");
        assertEq(_mint(ATTACKER, 499.99 ether), 49_999 ether, "almost the whole budget at once");

        vm.warp(t0 + 3_600); // one second later
        uint256 available = 1 ether + limit / 3_600;
        assertEq(nusd.mintAvailableInWindow(), available, "the 1 NUSD left over plus one second of refill");
        vm.prank(ATTACKER);
        vm.expectRevert(abi.encodeWithSelector(OracleNUSDv2.MintRateLimited.selector, limit, available));
        nusd.mintAtOracle{value: 500 ether}(0, ATTACKER);
        assertEq(nusd.totalSupply(), limit, "one budget outstanding, not two");

        vm.warp(t0 + 3_599 + 30 minutes);
        assertEq(nusd.mintAvailableInWindow(), 1 ether + limit / 2, "half is back after half an hour");
        vm.warp(t0 + 3_599 + 1 hours);
        assertEq(nusd.mintAvailableInWindow(), limit, "whole again after an hour");
    }

    /// A-06 (accepted; the deploy script now refuses zero fees) (a): the mint budget counts gross
    /// mints. With zero fees BOB mints the whole 150 NUSD budget and redeems it, getting his
    /// 1.5 zkLTC back, and an honest mint reverts MintRateLimited(100, 0) while supply is 0. With
    /// the fees a deployment must set, each such hour costs him both fees on the whole budget.
    /// A-06 (b): the ceiling is raised on the supply after a mint and never lowered. BOB mints
    /// 800,000 NUSD (80% of the 1,000,000 ceiling) and redeems it: the ceiling is 2,000,000 with
    /// zero supply. A week later the same move makes it 4,000,000. BOB's cost is zero.
    function testAudit_A06_grossMintAccountingBlocksMintsAndRatchetsCeiling() public {
        _deploy(1_000_000 ether);
        uint256 bobBefore = BOB.balance;

        // ---- (a) budget exhaustion
        nusd.setMintGuards(90 minutes, 150 ether);
        uint256 minted = _mint(BOB, 1.5 ether);
        assertEq(_redeem(BOB, minted), 1.5 ether, "round trip is free at zero fees");
        assertEq(nusd.totalSupply(), 0, "nothing is outstanding");
        assertEq(nusd.mintAvailableInWindow(), 0, "yet the hour's budget is gone");
        vm.prank(HOLDER);
        vm.expectRevert(abi.encodeWithSelector(OracleNUSDv2.MintRateLimited.selector, 100 ether, 0));
        nusd.mintAtOracle{value: 1 ether}(0, HOLDER);

        // ---- (b) ceiling ratchet (budget lifted so only the ceiling is in play)
        nusd.setMintGuards(90 minutes, type(uint96).max);
        assertEq(nusd.supplyCeilingNusd(), 1_000_000 ether, "ceiling before");
        minted = _mint(BOB, 8_000 ether); // 800,000 NUSD = 80% of the ceiling
        _redeem(BOB, minted);
        assertEq(nusd.totalSupply(), 0, "supply is zero again");
        assertEq(nusd.supplyCeilingNusd(), 2_000_000 ether, "ceiling doubled and stays doubled");

        vm.warp(vm.getBlockTimestamp() + 7 days);
        minted = _mint(BOB, 16_000 ether);
        _redeem(BOB, minted);
        assertEq(nusd.totalSupply(), 0, "supply is zero a second time");
        assertEq(nusd.supplyCeilingNusd(), 4_000_000 ether, "doubled again a week later");
        assertEq(BOB.balance, bobBefore, "at no cost");
    }

    /// A-07 (fixed): releaseSurplus did not check mintPaused. With the feed misreporting $200 and
    /// minting paused, a stranger's release still minted 10,000 NUSD (100% of supply) against the
    /// distrusted price and true backing fell from 3.0x to 1.5x. The pause now covers the release.
    /// (Since the second review one release is also capped at a step, a tenth of the supply.)
    function testAudit_A07_mintPauseAlsoStopsTheSurplusRelease() public {
        _deploy(10_000_000 ether);
        nusd.setSurplusRecipients(STAKING, TREASURY, 2_000);
        _mint(HOLDER, 100 ether); // 10,000 NUSD
        nusd.coverReserve{value: 200 ether}();
        assertEq(nusd.backingRatioWad(), 3 ether, "3.0x at the real price");

        oracle.setPrice(200 ether); // the feed doubles, still inside the adapter's $10-$1,000 bounds
        nusd.setMintPaused(true); // the pauser reacts

        (uint256 capacity, bool ready) = nusd.surplusMintCapacity();
        assertEq(capacity, 1_000 ether, "the distrusted price would release a step, 10% of supply");
        assertFalse(ready, "but nothing is ready while minting is paused");
        vm.prank(STRANGER);
        vm.expectRevert(OracleNUSDv2.MintPaused.selector);
        nusd.releaseSurplus();

        oracle.setPrice(100 ether); // the feed is corrected
        nusd.setMintPaused(false);
        assertEq(nusd.totalSupply(), 10_000 ether, "nothing was minted");
        assertEq(nusd.backingRatioWad(), 3 ether, "backing is intact");
        vm.expectRevert(
            abi.encodeWithSelector(OracleNUSDv2.SurplusBelowTrigger.selector, 30_000 ether, 10_000 ether)
        );
        nusd.releaseSurplus();
    }
}
