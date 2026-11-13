// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {TestBase} from "../TestBase.sol";
import {OracleNUSDv2} from "../../src/nusd/OracleNUSDv2.sol";
import {IPriceOracle} from "../../src/oracle/IPriceOracle.sol";
import {MockPriceOracle} from "../mocks/TokenomicsMocks.sol";

/// Tests for finding R2-N-01 of the second review of the 2026-11 audit (docs/AUDIT_2026-11.md).
///
/// The hourly mint budget bounds what a wrong price can mint through mintAtOracle. The surplus
/// release drew on no budget: it minted everything between the floor and the price it was shown,
/// in one call, and the staking pool makes that call by itself on every stake and claim. As
/// reviewed, with 400,000 NUSD at 3.0x and one round reporting twice the real price, a mint above
/// the 100,000 budget was refused while the release minted 400,000 NUSD (100% of supply) and the
/// backing at the real price fell to 1.5x; with 250,000 NUSD and one round at four times the price
/// it minted 750,000 and left NUSD backed 0.75x. One release now mints at most what a release
/// exactly at the trigger would: a tenth of the supply at 3.3x over 3.0x.
///
/// The third review (R3-N-01 to R3-N-03) found that this step was sized on the supply a release is
/// measured against, which remembers redeemed NUSD, and that a release cut down to the ceiling's
/// headroom could be turned into dust. The step now follows the supply that exists, and a release
/// that does not fit under the ceiling waits whole. A review of that change (R4-N-01, R4-N-02)
/// found that the wait could last until somebody minted; a release now lifts the ceiling when a
/// mint of one wei would. The last eleven tests are for those.
contract AuditNUSDSurplusTest is TestBase {
    uint256 private constant PRICE = 100 ether; // $100 per zkLTC

    address private constant HOLDER = address(0xA11CE);
    address private constant ATTACKER = address(0xBAD);
    address private constant STAKING = address(0x57A6);
    address private constant TREASURY = address(0x7EA5);
    address private constant STRANGER = address(0x5757);

    MockPriceOracle private oracle;
    OracleNUSDv2 private nusd;

    function setUp() public {
        vm.warp(1_000_000);
        vm.deal(HOLDER, 1_000_000 ether);
        vm.deal(ATTACKER, 1_000_000 ether);
        vm.deal(address(this), 1_000_000 ether);
        oracle = new MockPriceOracle(PRICE);
        nusd = new OracleNUSDv2(IPriceOracle(address(oracle)), address(this), 1_000_000 ether);
        nusd.setSurplusRecipients(STAKING, TREASURY, 2_000);
    }

    /// Supply at 3.0x of the real price, with the deployment's largest mint budget (100,000 an hour).
    function _stage(uint256 supplyNusd) private {
        vm.prank(HOLDER);
        nusd.mintAtOracle{value: supplyNusd / 100}(0, HOLDER);
        nusd.coverReserve{value: supplyNusd / 50}();
        nusd.setMintGuards(90 minutes, 100_000 ether);
        vm.warp(vm.getBlockTimestamp() + 1 hours); // the budget is whole again
        assertEq(nusd.totalSupply(), supplyNusd, "supply");
        assertEq(nusd.backingRatioWad(), 3 ether, "3.0x at the real price: no release is due");
        (, bool ready) = nusd.surplusMintCapacity();
        assertFalse(ready, "nothing to release");
    }

    function testAudit_R2N01_oneWrongRoundReleasesOneStepNotTheWholeSurplus() public {
        _stage(400_000 ether);

        oracle.setPrice(200 ether); // one round at twice the real price

        // The mint budget holds against that price ...
        vm.prank(ATTACKER);
        vm.expectRevert(abi.encodeWithSelector(OracleNUSDv2.MintRateLimited.selector, 100_200 ether, 100_000 ether));
        nusd.mintAtOracle{value: 501 ether}(0, ATTACKER);

        // ... and the release, which draws on no budget, is now one step.
        (uint256 capacity, bool ready) = nusd.surplusMintCapacity();
        assertTrue(ready, "6.0x at the wrong price");
        assertEq(capacity, 40_000 ether, "a tenth of the supply, where the wrong price has room for 400,000");
        vm.prank(STRANGER);
        assertEq(nusd.releaseSurplus(), 40_000 ether, "released by anyone, as before");
        assertEq(nusd.balanceOf(STAKING), 32_000 ether, "80%");
        assertEq(nusd.balanceOf(TREASURY), 8_000 ether, "20%");

        // It cannot be repeated for a week, whatever the price says.
        vm.expectRevert(
            abi.encodeWithSelector(OracleNUSDv2.SurplusTooSoon.selector, vm.getBlockTimestamp() + 7 days)
        );
        nusd.releaseSurplus();

        oracle.setPrice(PRICE); // the next round is right again
        assertApproxEq(nusd.backingRatioWad(), 2.7272 ether, 0.0001 ether, "2.73x at the real price, not 1.5x");
    }

    /// The round that left NUSD under-backed as reviewed: four times the real price.
    function testAudit_R2N01_aWrongRoundCanNoLongerLeaveNusdUnderBacked() public {
        _stage(250_000 ether);

        oracle.setPrice(400 ether);
        assertEq(nusd.releaseSurplus(), 25_000 ether, "one step, where the wrong price has room for 750,000");
        oracle.setPrice(PRICE);
        assertApproxEq(nusd.backingRatioWad(), 2.7272 ether, 0.0001 ether, "2.73x at the real price, not 0.75x");
        assertEq(nusd.quoteRedeem(100 ether), 1 ether, "100 NUSD still redeem for $100 of zkLTC");
    }

    /// A price that stays wrong mints one step a week, which leaves a week between steps to pause.
    function testAudit_R2N01_aPriceThatStaysWrongMintsOneStepAWeek() public {
        _stage(400_000 ether);
        oracle.setPrice(400 ether);

        uint256 supply = 400_000 ether;
        for (uint256 week; week < 3; ++week) {
            assertEq(nusd.releaseSurplus(), supply / 10, "a tenth of the supply of that week");
            supply += supply / 10;
            vm.warp(vm.getBlockTimestamp() + 7 days);
        }
        assertEq(nusd.totalSupply(), 532_400 ether, "400,000 x 1.1^3 after three weeks");

        nusd.setMintPaused(true); // the pauser reacts in week four
        vm.expectRevert(OracleNUSDv2.MintPaused.selector);
        nusd.releaseSurplus();
        oracle.setPrice(PRICE);
        assertApproxEq(nusd.backingRatioWad(), 2.2539 ether, 0.0001 ether, "12,000 zkLTC behind 532,400 NUSD");
    }

    /// The step is the one a release exactly at the trigger mints, so the ordinary release is
    /// unchanged: at 3.3x it still brings the ratio down to 3.0x in one call.
    function testAudit_R2N01_aReleaseAtTheTriggerIsUnchanged() public {
        _stage(400_000 ether);
        oracle.setPrice(110 ether); // a real 10% rise: 3.3x
        assertEq(nusd.releaseSurplus(), 40_000 ether, "the whole surplus over the floor");
        assertEq(nusd.backingRatioWad(), 3 ether, "exactly 3.0x");
    }

    /// R3-N-01. As reviewed, a mint and a redemption of one budget load in the same block (two
    /// fees, 4.9875 zkLTC) raised the remembered supply to 499,500, and the wrong round then
    /// released 49,950 NUSD instead of 40,000.
    function testAudit_R3N01_aRoundTripNoLongerEnlargesTheStep() public {
        _stage(400_000 ether);
        nusd.setFees(50, 50);
        oracle.setPrice(200 ether); // one round at twice the real price

        vm.prank(ATTACKER);
        uint256 minted = nusd.mintAtOracle{value: 500 ether}(0, ATTACKER);
        assertEq(minted, 99_500 ether, "one budget load");
        vm.prank(ATTACKER);
        nusd.redeemAtOracle(minted, 0, ATTACKER);
        assertEq(nusd.totalSupply(), 400_000 ether, "the supply is what it was");
        assertEq(nusd.surplusSupplyBasis(), 499_500 ether, "and the round trip is remembered");

        assertEq(nusd.releaseSurplus(), 40_000 ether, "a tenth of the supply that exists");
    }

    /// R3-N-01. Supply that left by ordinary redemptions does not count either. As reviewed, after
    /// 500,000 NUSD had shrunk to 200,000 a round 50% too high released 50,000: a quarter of the
    /// supply that was left.
    function testAudit_R3N01_afterRedemptionsTheStepFollowsWhatIsLeft() public {
        _stage(500_000 ether);
        vm.prank(HOLDER);
        nusd.redeemAtOracle(300_000 ether, 0, HOLDER);
        assertEq(nusd.surplusSupplyBasis(), 500_000 ether, "the redeemed supply still counts for the trigger");

        oracle.setPrice(150 ether); // 12,000 zkLTC: 3.6x of the remembered 500,000
        assertEq(nusd.releaseSurplus(), 20_000 ether, "a tenth of the 200,000 that exist");
    }

    /// R3-N-01, what is left and accepted (R4-N-03). NUSD minted before a release and still held
    /// when it runs enlarges it by a tenth of that NUSD: the supply really is larger. Mints over
    /// several hours add up, so what bounds it is the ceiling, not one hourly budget. It costs
    /// both fees on everything minted, and the extra goes to the stakers and the treasury, which
    /// pays the doer only as a staker (from about 12.5% of the pool at fees of 0.5% each way).
    function testAudit_R3N01_accepted_aMintAroundTheReleaseEnlargesItByATenthOfTheMint() public {
        _stage(400_000 ether);
        nusd.setFees(50, 50);
        oracle.setPrice(200 ether);

        vm.prank(ATTACKER);
        uint256 minted = nusd.mintAtOracle{value: 500 ether}(0, ATTACKER);
        assertEq(nusd.releaseSurplus(), 49_950 ether, "a tenth of 400,000 and of the 99,500 just minted");
        uint256 balanceBefore = ATTACKER.balance;
        vm.prank(ATTACKER);
        nusd.redeemAtOracle(minted, 0, ATTACKER);
        assertEq(500 ether - (ATTACKER.balance - balanceBefore), 4.9875 ether, "for the two fees: 4.9875 zkLTC");
    }

    /// R3-N-03. With no supply there is nothing to release into, also while a redemption is still
    /// remembered. As reviewed, after everyone had redeemed 100,000 NUSD at 4.5x a stranger's
    /// release minted 10,000 NUSD into a supply of zero.
    function testAudit_R3N03_nothingIsReleasedIntoASupplyOfZero() public {
        _stage(100_000 ether);
        nusd.coverReserve{value: 1_500 ether}(); // 4.5x
        vm.prank(HOLDER);
        nusd.redeemAtOracle(100_000 ether, 0, HOLDER);
        assertEq(nusd.totalSupply(), 0, "everyone has left");
        assertEq(nusd.surplusSupplyBasis(), 100_000 ether, "the redemption is remembered");

        (uint256 capacity, bool ready) = nusd.surplusMintCapacity();
        assertEq(capacity, 0, "no step on a supply of zero");
        assertFalse(ready, "no release");
        vm.prank(STRANGER);
        vm.expectRevert(
            abi.encodeWithSelector(OracleNUSDv2.SurplusBelowTrigger.selector, 350_000 ether, 100_000 ether)
        );
        nusd.releaseSurplus();
        assertEq(nusd.lastSurplusReleaseAt(), 0, "the refused call does not use the week");

        // The same once the redemption is forgotten: no supply, no step.
        vm.warp(vm.getBlockTimestamp() + 15 days);
        assertEq(nusd.surplusSupplyBasis(), 0, "nothing is remembered any more");
        (capacity, ready) = nusd.surplusMintCapacity();
        assertEq(capacity, 0, "still no step");
        assertFalse(ready, "still no release");

        // The reserve waits for the next minter and then goes out a step at a time.
        vm.prank(ATTACKER);
        nusd.mintAtOracle{value: 10 ether}(0, ATTACKER);
        assertEq(nusd.releaseSurplus(), 100 ether, "a tenth of the 1,000 NUSD that exist now");
    }

    /// R4-N-02, accepted. The step follows the supply that exists, so on a supply of dust a
    /// release is dust and still uses the week. After everyone has left, anyone can do that for
    /// 1 wei, and the first real minter's step comes a week later. Nobody is staked at a supply of
    /// zero and the reserve stays where it is, so this is left as it is.
    function testAudit_R4N02_accepted_aDustSupplyReleaseUsesTheWeek() public {
        _stage(100_000 ether);
        nusd.coverReserve{value: 1_500 ether}(); // 4.5x
        vm.prank(HOLDER);
        nusd.redeemAtOracle(100_000 ether, 0, HOLDER);

        vm.prank(ATTACKER);
        nusd.mintAtOracle{value: 1}(0, ATTACKER); // 100 wei of NUSD for 1 wei of zkLTC
        assertEq(nusd.releaseSurplus(), 10, "ten wei: a tenth of the supply that exists");

        vm.prank(HOLDER);
        nusd.mintAtOracle{value: 999 ether}(0, HOLDER); // 99,900 NUSD
        vm.expectRevert(
            abi.encodeWithSelector(OracleNUSDv2.SurplusTooSoon.selector, vm.getBlockTimestamp() + 7 days)
        );
        nusd.releaseSurplus();
        vm.warp(vm.getBlockTimestamp() + 7 days);
        assertEq(nusd.releaseSurplus(), 9_990 ether + 11, "the step of the real supply, a week late");
    }

    /// R4-N-01 (review of the fourth pass). Only a mint could raise the ceiling, so weekly
    /// releases alone carried the supply to within a step of it and then waited until somebody
    /// minted: as reviewed, from 76% of the ceiling the third release never came. A release now
    /// lifts the ceiling exactly when a mint of one wei would: when the supply already uses 80% of
    /// it and the last raise is a week old.
    function testAudit_R4N01_releasesAloneNeverStopAtTheCeiling() public {
        _stage(760_000 ether); // 76% of a ceiling of 1,000,000 that has never been raised
        oracle.setPrice(400 ether); // 12x: months of surplus

        uint256 supply = 760_000 ether;
        uint256 ceiling = 1_000_000 ether;
        uint256 lastRaise;
        for (uint256 week; week < 12; ++week) {
            // What a mint of one wei would do to the ceiling at this moment.
            if (supply * 10 >= ceiling * 8 && vm.getBlockTimestamp() >= lastRaise + 7 days) {
                ceiling *= 2;
                lastRaise = vm.getBlockTimestamp();
            }
            assertEq(nusd.releaseSurplus(), supply / 10, "one step a week, with nobody minting");
            supply += supply / 10;
            assertEq(nusd.supplyCeilingNusd(), ceiling, "the ceiling a one-wei mint would have left");
            assertEq(nusd.lastCeilingRaiseAt(), lastRaise, "raised when that mint would have raised it");
            vm.warp(vm.getBlockTimestamp() + 7 days);
        }
        assertEq(nusd.totalSupply(), supply, "760,000 x 1.1^12");
        assertGt(supply, 2_000_000 ether, "past the first ceiling and the second");
        assertEq(ceiling, 4_000_000 ether, "which doubled twice on the way, at 83.6% and at 81.5%");
    }

    /// R4-N-01 as a rule, at the default ratios and for any supply, ceiling, price and time since
    /// the ceiling last rose: a due release is ready exactly when the whole step fits under the
    /// ceiling a mint of one wei would find; once the weekly raise is due it never waits; it mints
    /// the whole step or nothing; and the supply never passes the ceiling.
    function testFuzzAudit_R4N01_aDueReleaseWaitsOnlyForTheWeeklyRaise(
        uint256 supplySeed,
        uint256 ceilingSeed,
        uint256 ageSeed,
        uint256 priceSeed
    ) public {
        uint256 supply = bound(supplySeed, 1_000, 5_000_000) * 1 ether;
        OracleNUSDv2 token = new OracleNUSDv2(IPriceOracle(address(oracle)), address(this), supply);
        token.setSurplusRecipients(STAKING, TREASURY, 2_000);
        vm.prank(HOLDER);
        token.mintAtOracle{value: supply / 100}(0, HOLDER); // fills the ceiling, which doubles now
        token.coverReserve{value: supply / 50}(); // 3.0x at $100
        uint256 ceiling = bound(ceilingSeed, supply, supply * 2);
        token.setSupplyCeiling(ceiling);
        uint256 age = bound(ageSeed, 0, 14 days);
        vm.warp(vm.getBlockTimestamp() + age);
        oracle.setPrice(bound(priceSeed, 110 ether, 1_000 ether)); // 3.3x to 30x

        uint256 step = supply / 10;
        bool raiseDue = age >= 7 days && supply * 10 >= ceiling * 8;
        uint256 ceilingAfter = raiseDue ? ceiling * 2 : ceiling;
        bool fits = step <= ceilingAfter - supply;

        (uint256 capacity, bool ready) = token.surplusMintCapacity();
        assertTrue(ready == fits, "ready exactly when the whole step fits");
        if (age >= 7 days) assertTrue(ready, "once the weekly raise is due a release never waits");
        if (fits) {
            assertEq(capacity, step, "the whole step");
            assertEq(token.releaseSurplus(), step, "is what goes out");
            assertEq(token.supplyCeilingNusd(), ceilingAfter, "the ceiling a one-wei mint would leave");
            assertLe(token.totalSupply(), token.supplyCeilingNusd(), "never past the ceiling");
        } else {
            assertEq(capacity, 0, "nothing");
            vm.expectRevert(
                abi.encodeWithSelector(OracleNUSDv2.SurplusBelowTrigger.selector, token.reserveValueNusd(), supply)
            );
            token.releaseSurplus();
            assertEq(token.lastSurplusReleaseAt(), 0, "the week is not used up");
            assertEq(token.supplyCeilingNusd(), ceiling, "and the ceiling has not moved");
        }
    }

    /// R5-N-01 and R4-N-04, accepted. At ratios wider than the defaults (a trigger more than a
    /// quarter of the floor above it) a step can be too large for the ceiling while the supply
    /// uses less than 80% of it. A release does not lift the ceiling from there, as a mint of one
    /// wei would not: it waits until mints have taken the supply to 80%.
    function testAudit_R4N04_accepted_atWiderRatiosAReleaseCanWaitForMints() public {
        _stage(700_000 ether); // 70% of a ceiling of 1,000,000 that has never been raised
        nusd.setSurplusRatios(30_000, 45_000); // a step is half the supply
        oracle.setPrice(200 ether); // 6.0x

        (uint256 capacity, bool ready) = nusd.surplusMintCapacity();
        assertEq(capacity, 0, "350,000 has no room in the 300,000 left");
        assertFalse(ready, "and at 70% the ceiling does not move");
        vm.warp(vm.getBlockTimestamp() + 60 days);
        (, ready) = nusd.surplusMintCapacity();
        assertFalse(ready, "however long it waits");
        assertEq(nusd.supplyCeilingNusd(), 1_000_000 ether, "the ceiling is where it was");

        vm.prank(ATTACKER);
        nusd.mintAtOracle{value: 500 ether}(0, ATTACKER); // 100,000 NUSD take the supply to 80%
        assertEq(nusd.supplyCeilingNusd(), 2_000_000 ether, "the mint's own raise");
        assertEq(nusd.releaseSurplus(), 400_000 ether, "and the step goes out whole");
    }

    /// R4-N-04. At a trigger of twice the floor a step is as large as the supply. With the supply
    /// at the ceiling it still fits under the ceiling the release doubles first.
    function testAudit_R4N04_aStepAsLargeAsTheSupplyFitsAfterOneDoubling() public {
        _stage(1_000_000 ether); // the stage's mint doubles the ceiling to 2,000,000
        nusd.setSupplyCeiling(1_000_000 ether); // the admin puts it back: supply is at the ceiling
        nusd.setSurplusRatios(30_000, 60_000);
        oracle.setPrice(200 ether); // 6.0x: exactly the trigger

        (uint256 capacity, bool ready) = nusd.surplusMintCapacity();
        assertEq(capacity, 0, "a step of 1,000,000 has no room, and the ceiling rose an hour ago");
        assertFalse(ready, "it waits");

        vm.warp(vm.getBlockTimestamp() + 7 days);
        assertEq(nusd.releaseSurplus(), 1_000_000 ether, "the whole step, as large as the supply");
        assertEq(nusd.supplyCeilingNusd(), 2_000_000 ether, "under the ceiling the release doubled");
        assertEq(nusd.backingRatioWad(), 3 ether, "down to the floor");
    }

    /// R3-N-02. A release used to be cut down to the ceiling's headroom. As reviewed, an attacker
    /// minted the headroom away, called the release (it minted 79 wei and used up the week) and
    /// redeemed, for two fees; and a release that took the last headroom closed minting until the
    /// ceiling could rise again. A release that does not fit now waits whole.
    function testAudit_R3N02_aReleaseThatDoesNotFitUnderTheCeilingWaitsWhole() public {
        _stage(1_800_000 ether);
        uint256 raisedAt = vm.getBlockTimestamp() - 1 hours;
        assertEq(nusd.supplyCeilingNusd(), 2_000_000 ether, "the ceiling doubled with the stage's mint");
        assertEq(nusd.lastCeilingRaiseAt(), raisedAt, "an hour ago: not again for a week");
        oracle.setPrice(150 ether); // far above the trigger
        (uint256 capacity, bool ready) = nusd.surplusMintCapacity();
        assertEq(capacity, 180_000 ether, "one step fits in the 200,000 of headroom");
        assertTrue(ready, "and is due");

        // The attacker takes part of the headroom away and keeps what was minted.
        vm.prank(ATTACKER);
        uint256 minted = nusd.mintAtOracle{value: 300 ether}(0, ATTACKER);
        assertEq(minted, 45_000 ether, "155,000 of headroom left, less than the step of 184,500");
        (capacity, ready) = nusd.surplusMintCapacity();
        assertEq(capacity, 0, "a release that does not fit is not cut down");
        assertFalse(ready, "it waits");
        vm.prank(ATTACKER);
        vm.expectRevert(
            abi.encodeWithSelector(OracleNUSDv2.SurplusBelowTrigger.selector, 8_145_000 ether, 1_845_000 ether)
        );
        nusd.releaseSurplus();
        assertEq(nusd.lastSurplusReleaseAt(), 0, "the week is not used up");

        // R4-N-01: the wait used to last until somebody else minted. It now ends by itself when
        // the ceiling's weekly raise is due: the release lifts the ceiling as a mint would.
        vm.warp(raisedAt + 7 days - 1);
        (, ready) = nusd.surplusMintCapacity();
        assertFalse(ready, "one second early: still waiting");
        vm.warp(raisedAt + 7 days);
        vm.prank(STRANGER);
        assertEq(nusd.releaseSurplus(), 184_500 ether, "the whole step, with nobody minting first");
        assertEq(nusd.supplyCeilingNusd(), 4_000_000 ether, "the release doubled the ceiling");
        assertEq(nusd.lastCeilingRaiseAt(), raisedAt + 7 days, "and that is this week's raise");
        vm.prank(ATTACKER);
        assertEq(nusd.mintAtOracle{value: 100 ether}(0, ATTACKER), 15_000 ether, "and minting is open");
    }
}
