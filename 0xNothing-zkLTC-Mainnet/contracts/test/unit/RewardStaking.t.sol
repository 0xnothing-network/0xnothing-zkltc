// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {TestBase} from "../TestBase.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {RewardStaking} from "../../src/rewards/RewardStaking.sol";
import {MarketplaceNusdMock} from "../mocks/NusdMarketplaceMocks.sol";
import {MockHarvester, MockMintable} from "../mocks/TokenomicsMocks.sol";

contract RewardStakingTest is TestBase {
    uint32 private constant D30 = 30 days;
    uint32 private constant D90 = 90 days;
    uint32 private constant D180 = 180 days;
    uint32 private constant D365 = 365 days;
    /// Streaming rounds down by well under a wei per second.
    uint256 private constant DUST = 1e9;

    address private constant ALICE = address(0xA11CE);
    address private constant BOB = address(0xB0B);
    address private constant CAROL = address(0xCA201);
    address private constant STRANGER = address(0xBAD);

    MarketplaceNusdMock private nusd;
    RewardStaking private staking;

    function setUp() public {
        vm.warp(1_000_000);
        nusd = new MarketplaceNusdMock();
        staking = new RewardStaking(IERC20(address(nusd)));
        _fund(ALICE);
        _fund(BOB);
        _fund(CAROL);
    }

    function _fund(address account) private {
        nusd.mint(account, 1_000_000 ether);
        vm.prank(account);
        nusd.approve(address(staking), type(uint256).max);
    }

    function _stake(address account, uint256 amount, uint32 lock) private returns (uint256 positionId) {
        vm.prank(account);
        positionId = staking.stake(amount, lock);
    }

    function _income(uint256 amount) private {
        nusd.mint(address(staking), amount);
    }

    function _skip(uint256 seconds_) private {
        vm.warp(vm.getBlockTimestamp() + seconds_);
    }

    function _harvester() private returns (MockHarvester harvester) {
        harvester = new MockHarvester(MockMintable(address(nusd)));
        harvester.setStaking(address(staking));
        staking.bindHarvester(address(harvester));
    }

    // ---------------------------------------------------------------- locks

    function testLockMultipliersAndUnknownLock() public {
        assertEq(staking.lockMultiplierBps(D30), 10_000, "30 days x1");
        assertEq(staking.lockMultiplierBps(D90), 12_000, "90 days x1.2");
        assertEq(staking.lockMultiplierBps(D180), 15_000, "180 days x1.5");
        assertEq(staking.lockMultiplierBps(D365), 30_000, "365 days x3");

        vm.prank(ALICE);
        vm.expectRevert(RewardStaking.InvalidLockDuration.selector);
        staking.stake(1 ether, 31 days);
        vm.prank(ALICE);
        vm.expectRevert(RewardStaking.InvalidAmount.selector);
        staking.stake(0, D30);
    }

    // ---------------------------------------------------------------- streaming

    function testIncomeStreamsEvenlyOverSevenDays() public {
        _stake(ALICE, 100 ether, D30);
        _income(70 ether);
        staking.sync();
        assertEq(staking.rewardRate(), uint256(70 ether) / 7 days, "per second");
        assertEq(staking.periodFinish(), vm.getBlockTimestamp() + 7 days, "stream end");

        _skip(3.5 days);
        assertApproxEq(staking.earned(ALICE), 35 ether, DUST, "half way");
        _skip(3.5 days);
        assertApproxEq(staking.earned(ALICE), 70 ether, DUST, "all of it");
        _skip(30 days);
        assertApproxEq(staking.earned(ALICE), 70 ether, DUST, "nothing after the stream");
        assertEq(staking.rewardRate(), 0, "stream over");

        uint256 before = nusd.balanceOf(ALICE);
        vm.prank(ALICE);
        uint256 claimed = staking.claim(ALICE);
        assertApproxEq(claimed, 70 ether, DUST, "claimed");
        assertEq(nusd.balanceOf(ALICE) - before, claimed, "paid");

        vm.prank(ALICE);
        vm.expectRevert(RewardStaking.NothingToClaim.selector);
        staking.claim(ALICE);
    }

    function testRewardsFollowWeight() public {
        _stake(ALICE, 100 ether, D30); // weight 100
        _stake(BOB, 100 ether, D365); // weight 300
        _income(400 ether);
        staking.sync();
        _skip(7 days);
        assertApproxEq(staking.earned(ALICE), 100 ether, DUST, "x1");
        assertApproxEq(staking.earned(BOB), 300 ether, DUST, "x3");
    }

    function testLateJoinerOnlyEarnsFromWhenTheyJoin() public {
        _stake(ALICE, 100 ether, D30);
        _income(70 ether);
        staking.sync();
        _skip(3.5 days);
        _stake(BOB, 100 ether, D30);
        _skip(3.5 days);
        assertApproxEq(staking.earned(ALICE), 52.5 ether, DUST, "all of the first half, half of the second");
        assertApproxEq(staking.earned(BOB), 17.5 ether, DUST, "half of the second half");
    }

    function testStreamHoldsWhileNobodyIsStaked() public {
        _income(70 ether);
        staking.sync();
        assertEq(staking.rewardRate(), 0, "nobody to pay");

        _skip(30 days); // far longer than the stream itself
        _stake(ALICE, 100 ether, D30);
        assertEq(staking.periodFinish(), vm.getBlockTimestamp() + 7 days, "the full week is still ahead");
        assertGt(staking.rewardRate(), 0, "streaming resumes");
        _skip(7 days);
        assertApproxEq(staking.earned(ALICE), 70 ether, DUST, "nothing was lost while paused");
    }

    function testStreamPausesWhenTheLastStakerLeaves() public {
        _stake(ALICE, 100 ether, D30);
        _skip(30 days);
        _income(70 ether);
        staking.sync();
        _skip(1 days);
        vm.prank(ALICE);
        staking.withdraw(1);
        assertApproxEq(staking.earned(ALICE), 10 ether, DUST, "one day of seven");

        _skip(20 days);
        _stake(BOB, 100 ether, D30);
        _skip(7 days);
        assertApproxEq(staking.earned(BOB), 60 ether, DUST, "the six days left");
    }

    function testNewIncomeIsResmoothedWithWhatIsLeft() public {
        _stake(ALICE, 100 ether, D30);
        _income(70 ether);
        staking.sync();
        _skip(3.5 days);
        _income(35 ether);
        staking.sync(); // 35 unstreamed + 35 new over a fresh week
        assertApproxEq(staking.rewardRate(), uint256(70 ether) / 7 days, 1, "re-smoothed rate");
        _skip(7 days);
        assertApproxEq(staking.earned(ALICE), 105 ether, DUST, "everything");
    }

    function testIncomeIsPickedUpByTheNextInteraction() public {
        _stake(ALICE, 100 ether, D30);
        _income(70 ether); // nobody calls sync
        assertEq(staking.queuedRewards(), 70 ether, "visible as queued");
        assertEq(staking.earned(ALICE), 0, "not streaming yet");

        _skip(1 days);
        _stake(BOB, 100 ether, D30); // any interaction starts it
        _skip(7 days);
        assertApproxEq(staking.earned(ALICE) + staking.earned(BOB), 70 ether, DUST, "all streamed");
        assertApproxEq(staking.earned(ALICE), 35 ether, DUST, "even split from the pickup");
        assertApproxEq(staking.queuedRewards(), 0, DUST, "nothing left");
    }

    // ---------------------------------------------------------------- claims and positions

    function testClaimToAnotherRecipient() public {
        _stake(ALICE, 100 ether, D30);
        _income(7 ether);
        staking.sync();
        _skip(7 days);
        vm.prank(ALICE);
        vm.expectRevert(RewardStaking.InvalidRecipient.selector);
        staking.claim(address(0));
        vm.prank(ALICE);
        uint256 claimed = staking.claim(STRANGER);
        assertEq(nusd.balanceOf(STRANGER), claimed, "sent to recipient");
    }

    function testClaimAndStakeCompoundsWithoutMovingNusd() public {
        _stake(ALICE, 100 ether, D30);
        vm.prank(ALICE);
        vm.expectRevert(RewardStaking.NothingToClaim.selector);
        staking.claimAndStake(D365);

        _income(70 ether);
        staking.sync();
        _skip(7 days);
        uint256 held = nusd.balanceOf(address(staking));
        uint256 reward = staking.earned(ALICE);

        vm.prank(ALICE);
        uint256 positionId = staking.claimAndStake(D365);
        RewardStaking.Position memory position = staking.getPosition(positionId);
        assertEq(position.amount, reward, "reward became principal");
        assertEq(position.weight, reward * 3, "x3 lock");
        assertEq(nusd.balanceOf(address(staking)), held, "no NUSD moved");
        assertEq(staking.totalPrincipal(), 100 ether + reward, "principal");
        assertEq(staking.earned(ALICE), 0, "claimed");
        assertEq(staking.rewardPaid(), reward, "booked as paid");
        assertEq(staking.queuedRewards(), 0, "not mistaken for new income");
    }

    function testWithdrawReturnsPrincipalAfterUnlockOnly() public {
        uint256 positionId = _stake(ALICE, 100 ether, D30);
        uint256 unlock = vm.getBlockTimestamp() + D30;

        vm.prank(ALICE);
        vm.expectRevert(abi.encodeWithSelector(RewardStaking.PositionLocked.selector, unlock));
        staking.withdraw(positionId);
        vm.prank(STRANGER);
        vm.expectRevert(RewardStaking.NotPositionOwner.selector);
        staking.withdraw(positionId);
        vm.prank(ALICE);
        vm.expectRevert(RewardStaking.UnknownPosition.selector);
        staking.withdraw(99);

        _income(7 ether);
        staking.sync();
        vm.warp(unlock);
        uint256 before = nusd.balanceOf(ALICE);
        vm.prank(ALICE);
        staking.withdraw(positionId);
        assertEq(nusd.balanceOf(ALICE) - before, 100 ether, "principal in full");
        assertApproxEq(staking.earned(ALICE), 7 ether, DUST, "earned reward stays claimable");

        vm.prank(ALICE);
        vm.expectRevert(RewardStaking.AlreadyWithdrawn.selector);
        staking.withdraw(positionId);
        assertEq(staking.positionIdsOf(ALICE).length, 1, "position kept as history");
    }

    function testFeeOnTransferStakeIsRejected() public {
        nusd.setTaxed(true);
        vm.prank(ALICE);
        vm.expectRevert(RewardStaking.NonExactTransfer.selector);
        staking.stake(100 ether, D30);
    }

    // ---------------------------------------------------------------- harvest

    function testHarvesterBindsOnceByTheDeployer() public {
        MockHarvester harvester = new MockHarvester(MockMintable(address(nusd)));
        vm.prank(STRANGER);
        vm.expectRevert(RewardStaking.Unauthorized.selector);
        staking.bindHarvester(address(harvester));
        vm.expectRevert(RewardStaking.InvalidHarvester.selector);
        staking.bindHarvester(STRANGER);

        staking.bindHarvester(address(harvester));
        assertEq(staking.harvester(), address(harvester), "bound");
        vm.expectRevert(RewardStaking.HarvesterAlreadyBound.selector);
        staking.bindHarvester(address(harvester));
    }

    function testStakeAndClaimHarvestFirst() public {
        MockHarvester harvester = _harvester();
        harvester.setNextPayment(70 ether);
        _stake(ALICE, 100 ether, D30);
        assertEq(harvester.calls(), 1, "stake harvested");
        assertEq(staking.rewardFunded(), 70 ether, "fees picked up at once");

        _skip(7 days);
        vm.prank(ALICE);
        uint256 claimed = staking.claim(ALICE);
        assertApproxEq(claimed, 70 ether, DUST, "streamed to the staker");
        assertEq(harvester.calls(), 2, "claim harvested");

        staking.sync();
        assertEq(harvester.calls(), 3, "sync harvested");
    }

    function testABrokenHarvestNeverBlocksStakers() public {
        MockHarvester harvester = _harvester();
        harvester.setMode(MockHarvester.Mode.Revert);
        uint256 positionId = _stake(ALICE, 100 ether, D30);

        harvester.setMode(MockHarvester.Mode.BurnGas);
        _stake(BOB, 100 ether, D30);
        _income(7 ether);
        _skip(7 days);
        staking.sync();
        _skip(7 days);
        vm.prank(BOB);
        staking.claim(BOB);

        _skip(30 days);
        vm.prank(ALICE);
        staking.withdraw(positionId);
        assertEq(harvester.calls(), 0, "no harvest ever completed");
    }

    function testWithdrawNeverRunsTheHarvest() public {
        MockHarvester harvester = _harvester();
        uint256 positionId = _stake(ALICE, 100 ether, D30);
        assertEq(harvester.calls(), 1, "stake harvested");
        _skip(D30);
        vm.prank(ALICE);
        staking.withdraw(positionId);
        assertEq(harvester.calls(), 1, "withdraw did not");
    }

    // ---------------------------------------------------------------- points

    function testPointsAccrueByWeightAndTime() public {
        _stake(ALICE, 100 ether, D30);
        _skip(10);
        assertEq(staking.pointsOf(ALICE), 1_000 ether, "100 weight x 10 s");
        _stake(BOB, 100 ether, D365);
        _skip(10);
        assertEq(staking.pointsOf(ALICE), 2_000 ether, "keeps accruing");
        assertEq(staking.pointsOf(BOB), 3_000 ether, "300 weight x 10 s");
        assertEq(staking.totalPointsNow(), 5_000 ether, "total");

        (uint256 weight, uint256 points, uint256 claimable) = staking.accountState(BOB);
        assertEq(weight, 300 ether, "weight");
        assertEq(points, 3_000 ether, "points");
        assertEq(claimable, 0, "nothing earned");
    }

    function testPointsStopWhenPrincipalLeaves() public {
        uint256 positionId = _stake(ALICE, 100 ether, D30);
        _skip(D30);
        vm.prank(ALICE);
        staking.withdraw(positionId);
        uint256 points = staking.pointsOf(ALICE);
        assertEq(points, 100 ether * uint256(D30), "lifetime points kept");
        _skip(10 days);
        assertEq(staking.pointsOf(ALICE), points, "no weight, no new points");
    }

    // ---------------------------------------------------------------- conservation

    function testPrincipalNeverPaysRewards() public {
        _stake(ALICE, 100 ether, D30);
        _stake(BOB, 50 ether, D90);
        _income(30 ether);
        staking.sync();
        _skip(7 days);
        vm.prank(ALICE);
        staking.claim(ALICE);
        vm.prank(BOB);
        staking.claim(BOB);

        _skip(D90);
        vm.prank(ALICE);
        staking.withdraw(1);
        vm.prank(BOB);
        staking.withdraw(2);
        assertEq(staking.totalPrincipal(), 0, "all principal returned");
        assertLe(nusd.balanceOf(address(staking)), DUST, "only rounding dust remains");
    }

    /// Random stakes, income, claims and time: rewards paid never exceed income, and every
    /// position's principal comes back in full.
    function testFuzzNeverPaysMoreThanIncome(uint256 seed) public {
        address[3] memory users = [ALICE, BOB, CAROL];
        uint32[4] memory locks = [D30, D90, D180, D365];
        uint256 totalIncome;
        uint256 totalStaked;
        uint256 totalClaimed;

        for (uint256 step; step < 24; ++step) {
            seed = uint256(keccak256(abi.encode(seed, step)));
            uint256 action = seed % 4;
            address user = users[(seed >> 8) % 3];
            if (action == 0) {
                uint256 amount = bound(seed >> 16, 1, 10_000 ether);
                _stake(user, amount, locks[(seed >> 128) % 4]);
                totalStaked += amount;
            } else if (action == 1) {
                uint256 amount = bound(seed >> 16, 1, 1_000 ether);
                _income(amount);
                totalIncome += amount;
            } else if (action == 2) {
                if (staking.earned(user) != 0) {
                    vm.prank(user);
                    totalClaimed += staking.claim(user);
                }
            } else {
                _skip(bound(seed >> 16, 1, 10 days));
            }
        }

        staking.sync();
        _skip(365 days + 7 days);
        uint256 withdrawn;
        for (uint256 index; index < 3; ++index) {
            address user = users[index];
            if (staking.earned(user) != 0) {
                vm.prank(user);
                totalClaimed += staking.claim(user);
            }
            uint256[] memory ids = staking.positionIdsOf(user);
            for (uint256 position; position < ids.length; ++position) {
                uint256 before = nusd.balanceOf(user);
                vm.prank(user);
                staking.withdraw(ids[position]);
                withdrawn += nusd.balanceOf(user) - before;
            }
        }

        assertEq(withdrawn, totalStaked, "principal not returned in full");
        assertLe(totalClaimed, totalIncome, "paid more than came in");
        if (totalStaked != 0) {
            // With someone staked during the whole tail, every income wei streams out bar dust.
            assertApproxEq(totalClaimed, totalIncome, 1e12, "income lost");
        }
    }
}
