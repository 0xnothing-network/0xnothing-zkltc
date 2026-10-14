// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {TestBase} from "../TestBase.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {RewardStaking} from "../../src/rewards/RewardStaking.sol";
import {MarketplaceNusdMock} from "../mocks/NusdMarketplaceMocks.sol";

contract RewardStakingTest is TestBase {
    uint256 private constant ROUND = 10_000 ether;
    uint32 private constant D30 = 30 days;
    uint32 private constant D365 = 365 days;

    MarketplaceNusdMock private nusd;
    RewardStaking private staking;

    address private constant ALICE = address(0xA11CE);
    address private constant BOB = address(0xB0B);
    address private constant CAROL = address(0xCA201);
    address private constant FEES = address(0xFEE5);

    address[3] private actors = [ALICE, BOB, CAROL];

    function setUp() public {
        vm.warp(1_000_000);
        nusd = new MarketplaceNusdMock();
        staking = new RewardStaking(IERC20(address(nusd)));
        for (uint256 i; i < actors.length; ++i) {
            nusd.mint(actors[i], 10_000_000 ether);
            vm.prank(actors[i]);
            nusd.approve(address(staking), type(uint256).max);
        }
    }

    function _stake(address account, uint256 amount, uint32 lock) private returns (uint256 positionId) {
        vm.prank(account);
        positionId = staking.stake(amount, lock);
    }

    function _fund(uint256 amount) private {
        nusd.mint(FEES, amount);
        vm.prank(FEES);
        nusd.transfer(address(staking), amount);
    }

    function _claimable(address account) private view returns (uint256 claimable) {
        (,, claimable) = staking.accountState(account);
    }

    function _claim(address account) private returns (uint256 amount) {
        if (_claimable(account) == 0) return 0;
        vm.prank(account);
        amount = staking.claim(account);
    }

    function _assertNear(uint256 actual, uint256 expected, uint256 tolerance, string memory message) private pure {
        uint256 diff = actual > expected ? actual - expected : expected - actual;
        assertLe(diff, tolerance, message);
    }

    function testLockMultipliersAndUnknownLock() public {
        assertEq(staking.lockMultiplierBps(30 days), 10_000, "30d");
        assertEq(staking.lockMultiplierBps(90 days), 12_000, "90d");
        assertEq(staking.lockMultiplierBps(180 days), 15_000, "180d");
        assertEq(staking.lockMultiplierBps(365 days), 30_000, "365d");

        vm.prank(ALICE);
        vm.expectRevert(RewardStaking.InvalidLockDuration.selector);
        staking.stake(1 ether, 31 days);
        vm.prank(ALICE);
        vm.expectRevert(RewardStaking.InvalidAmount.selector);
        staking.stake(0, D30);
    }

    function testPrincipalIsLockedThenReturnedInFull() public {
        uint256 id = _stake(ALICE, 100 ether, D365);
        RewardStaking.Position memory position = staking.getPosition(id);
        assertEq(position.weight, 300 ether, "3x weight");
        assertEq(position.unlockTime, vm.getBlockTimestamp() + D365, "unlock time");

        vm.prank(ALICE);
        vm.expectRevert(abi.encodeWithSelector(RewardStaking.PositionLocked.selector, uint64(vm.getBlockTimestamp() + D365)));
        staking.withdraw(id);
        vm.prank(BOB);
        vm.expectRevert(RewardStaking.NotPositionOwner.selector);
        staking.withdraw(id);

        vm.warp(vm.getBlockTimestamp() + D365);
        uint256 before = nusd.balanceOf(ALICE);
        vm.prank(ALICE);
        staking.withdraw(id);
        assertEq(nusd.balanceOf(ALICE) - before, 100 ether, "principal back");
        assertEq(staking.totalPrincipal(), 0, "principal ledger");
        assertEq(staking.totalWeight(), 0, "weight ledger");

        vm.prank(ALICE);
        vm.expectRevert(RewardStaking.AlreadyWithdrawn.selector);
        staking.withdraw(id);
    }

    function testTriggerNeedsADayAFundedPoolAndPoints() public {
        vm.expectRevert(abi.encodeWithSelector(RewardStaking.RoundTooShort.selector, vm.getBlockTimestamp() + 1 days));
        staking.trigger();

        vm.warp(vm.getBlockTimestamp() + 1 days);
        _fund(ROUND - 1);
        vm.expectRevert(abi.encodeWithSelector(RewardStaking.PoolBelowThreshold.selector, ROUND - 1));
        staking.trigger();

        _fund(1);
        vm.expectRevert(RewardStaking.NoPointsInRound.selector);
        staking.trigger();

        _stake(ALICE, 1 ether, D30);
        vm.warp(vm.getBlockTimestamp() + 1);
        vm.prank(CAROL);
        staking.trigger();
        assertEq(staking.currentRound(), 1, "round closed by anyone");
    }

    function testPrincipalNeverCountsTowardThePool() public {
        _stake(ALICE, 50_000 ether, D30);
        _fund(ROUND - 1 ether);
        vm.warp(vm.getBlockTimestamp() + 1 days);

        assertEq(staking.availableRewards(), ROUND - 1 ether, "principal excluded");
        vm.expectRevert(abi.encodeWithSelector(RewardStaking.PoolBelowThreshold.selector, ROUND - 1 ether));
        staking.trigger();
    }

    function testRoundSplitsTenThousandByTimeWeightedPoints() public {
        _stake(ALICE, 100 ether, D30); // weight 100 for a full day
        vm.warp(vm.getBlockTimestamp() + 12 hours);
        _stake(BOB, 100 ether, D365); // weight 300 for half a day
        vm.warp(vm.getBlockTimestamp() + 12 hours - 1);
        _stake(CAROL, 1_000_000 ether, D30); // huge stake one second before the close
        vm.warp(vm.getBlockTimestamp() + 1);
        _fund(ROUND);

        staking.trigger();
        // Points: Alice 100*86400, Bob 300*43200, Carol 1e6*1 -> 8.64e6 : 1.296e7 : 1e6
        uint256 total = 8_640_000 + 12_960_000 + 1_000_000;
        _assertNear(_claimable(ALICE), ROUND * 8_640_000 / total, 2, "alice share");
        _assertNear(_claimable(BOB), ROUND * 12_960_000 / total, 2, "bob share");
        _assertNear(_claimable(CAROL), ROUND * 1_000_000 / total, 2, "late staker earns only its seconds");

        uint256 paid = _claim(ALICE) + _claim(BOB) + _claim(CAROL);
        assertLe(paid, ROUND, "overpaid round");
        _assertNear(paid, ROUND, 3, "round not fully distributed");
        assertEq(nusd.balanceOf(address(staking)), staking.totalPrincipal() + ROUND - paid, "ledger");
    }

    function testPointsResetEveryRound() public {
        _stake(ALICE, 100 ether, D30);
        vm.warp(vm.getBlockTimestamp() + 1 days);
        _fund(ROUND);
        staking.trigger();

        (uint256 weight, uint256 openPoints,) = staking.accountState(ALICE);
        assertEq(weight, 100 ether, "weight kept");
        assertEq(openPoints, 0, "points reset at the snapshot");
        assertEq(staking.openRoundPoints(), 0, "global points reset");

        vm.warp(vm.getBlockTimestamp() + 6 hours);
        (, openPoints,) = staking.accountState(ALICE);
        assertEq(openPoints, 100 ether * 6 hours, "new round accrues from zero");
        assertEq(staking.openRoundPoints(), openPoints, "global matches account");
    }

    function testIdleAccountCollectsEveryRoundItWasStakedFor() public {
        _stake(ALICE, 100 ether, D365);
        for (uint256 round; round < 3; ++round) {
            vm.warp(vm.getBlockTimestamp() + 1 days);
            if (round == 1) _stake(BOB, 300 ether, D30); // equal weight from mid-history onward
            _fund(ROUND);
            staking.trigger();
        }
        // Round 0: Alice alone. Round 1: Bob joins at the very close, so earns nothing there.
        // Round 2: equal weights. Alice 10k + 10k + 5k, Bob 5k.
        uint256 alice = _claim(ALICE);
        uint256 bob = _claim(BOB);
        assertLe(alice + bob, 3 * ROUND, "over-allocated");
        _assertNear(alice + bob, 3 * ROUND, 5, "rounds not distributed");
        _assertNear(bob, 5_000 ether, 1, "bob only shares the round it was staked for");
        assertEq(staking.totalAllocatedUnpaid(), 3 * ROUND - alice - bob, "unpaid ledger");
    }

    function testSurplusRollsIntoLaterRounds() public {
        _stake(ALICE, 1 ether, D30);
        _fund(25_000 ether);
        vm.warp(vm.getBlockTimestamp() + 1 days);
        staking.trigger();
        assertEq(staking.availableRewards(), 15_000 ether, "rolled over");

        vm.warp(vm.getBlockTimestamp() + 1 days);
        staking.trigger();
        assertEq(staking.availableRewards(), 5_000 ether, "second round");

        vm.warp(vm.getBlockTimestamp() + 1 days);
        vm.expectRevert(abi.encodeWithSelector(RewardStaking.PoolBelowThreshold.selector, 5_000 ether));
        staking.trigger();
    }

    function testWithdrawnStakeKeepsEarnedRewardsButStopsEarning() public {
        uint256 id = _stake(ALICE, 100 ether, D30);
        _stake(BOB, 100 ether, D365);
        vm.warp(vm.getBlockTimestamp() + D30);
        vm.prank(ALICE);
        staking.withdraw(id);
        vm.warp(vm.getBlockTimestamp() + D30);
        _fund(ROUND);
        staking.trigger();

        // Alice: 100 * 30d, Bob: 300 * 60d -> 1 : 6
        _assertNear(_claimable(ALICE), ROUND / 7, 2, "alice keeps points earned while staked");
        _assertNear(_claimable(BOB), ROUND * 6 / 7, 2, "bob share");
    }

    function testClaimToAnotherRecipientAndNothingTwice() public {
        _stake(ALICE, 1 ether, D30);
        vm.warp(vm.getBlockTimestamp() + 1 days);
        _fund(ROUND);
        staking.trigger();

        vm.prank(ALICE);
        vm.expectRevert(RewardStaking.InvalidRecipient.selector);
        staking.claim(address(0));

        vm.prank(ALICE);
        uint256 amount = staking.claim(CAROL);
        _assertNear(amount, ROUND, 1, "whole round");
        assertEq(nusd.balanceOf(CAROL), 10_000_000 ether + amount, "paid to recipient");

        vm.prank(ALICE);
        vm.expectRevert(RewardStaking.NothingToClaim.selector);
        staking.claim(ALICE);
    }

    function testFeeOnTransferStakeIsRejected() public {
        nusd.setTaxed(true);
        vm.prank(ALICE);
        vm.expectRevert(RewardStaking.NonExactTransfer.selector);
        staking.stake(10 ether, D30);
    }

    /// Random stakes, withdrawals, top-ups and triggers: rewards never exceed 10k per closed round,
    /// rounds are fully allocated up to rounding dust, and principal always comes back in full.
    function testFuzzRoundsNeverOverpayOrTouchPrincipal(uint256 seed) public {
        uint256 staked;
        for (uint256 step; step < 24; ++step) {
            uint256 r = uint256(keccak256(abi.encode(seed, step)));
            address actor = actors[r % 3];
            uint256 action = (r >> 8) % 4;
            if (action == 0) {
                uint256 amount = bound(r >> 16, 1, 100_000 ether);
                uint32 lock = [D30, uint32(90 days), uint32(180 days), D365][(r >> 128) % 4];
                _stake(actor, amount, lock);
                staked += amount;
            } else if (action == 1) {
                _fund(bound(r >> 16, 0, 12_000 ether));
            } else if (action == 2) {
                uint256[] memory ids = staking.positionIdsOf(actor);
                if (ids.length != 0) {
                    uint256 id = ids[(r >> 16) % ids.length];
                    RewardStaking.Position memory position = staking.getPosition(id);
                    if (!position.withdrawn && vm.getBlockTimestamp() >= position.unlockTime) {
                        vm.prank(actor);
                        staking.withdraw(id);
                        staked -= position.amount;
                    }
                }
            } else if (
                vm.getBlockTimestamp() >= staking.nextTriggerTime() && staking.availableRewards() >= ROUND
                    && staking.openRoundPoints() != 0
            ) {
                staking.trigger();
            } else {
                _claim(actor);
            }
            vm.warp(vm.getBlockTimestamp() + bound(r >> 200, 1, 20 days));
            assertEq(staking.totalPrincipal(), staked, "principal ledger drifted");
            assertGe(
                nusd.balanceOf(address(staking)),
                staking.totalPrincipal() + staking.totalAllocatedUnpaid(),
                "pool cannot cover its liabilities"
            );
        }

        for (uint256 i; i < actors.length; ++i) {
            _claim(actors[i]);
        }
        // Only rounding dust (a few wei per checkpoint) may stay allocated after everyone claims.
        uint256 unpaid = staking.totalAllocatedUnpaid();
        assertLe(unpaid, 64, "allocated rewards left unclaimable");

        vm.warp(vm.getBlockTimestamp() + D365);
        for (uint256 i; i < actors.length; ++i) {
            uint256[] memory ids = staking.positionIdsOf(actors[i]);
            for (uint256 j; j < ids.length; ++j) {
                if (staking.getPosition(ids[j]).withdrawn) continue;
                vm.prank(actors[i]);
                staking.withdraw(ids[j]);
            }
        }
        assertEq(staking.totalPrincipal(), 0, "principal left behind");
        assertGe(nusd.balanceOf(address(staking)), unpaid, "dust uncovered");
    }
}
