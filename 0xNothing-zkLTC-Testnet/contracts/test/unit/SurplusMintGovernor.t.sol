// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {TestBase} from "../TestBase.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {DIAOracleAdapter} from "../../src/nusd/DIAOracleAdapter.sol";
import {OracleNUSDv2} from "../../src/nusd/OracleNUSDv2.sol";
import {SurplusMintGovernor} from "../../src/governance/SurplusMintGovernor.sol";
import {MockDIAFeed} from "../mocks/MockDIAFeed.sol";

contract SurplusMintGovernorTest is TestBase {
    uint256 private constant LOCK = 100 ether;
    uint256 private constant VOTERS = 14;

    MockDIAFeed private feed;
    OracleNUSDv2 private nusd;
    SurplusMintGovernor private governor;
    uint80 private roundId = 1;

    address private constant POOL = address(0xB001);
    address private constant TREASURY = address(0x7EA5);
    address private constant FUNDER = address(0xF00D);
    address[] private voters;

    function setUp() public {
        vm.warp(1_000_000);
        feed = new MockDIAFeed(18);
        feed.setRound(roundId, 50 ether, vm.getBlockTimestamp(), roundId);
        DIAOracleAdapter oracle = new DIAOracleAdapter(address(feed), 90 minutes);
        nusd = new OracleNUSDv2(oracle, address(this), 10_000_000 ether);
        governor = new SurplusMintGovernor(IERC20(address(nusd)), POOL, TREASURY);
        nusd.bindSurplusMinter(address(governor));

        for (uint256 i; i < VOTERS; ++i) {
            address voter = address(uint160(0x1000 + i));
            voters.push(voter);
            vm.deal(voter, 2 ether);
            vm.prank(voter);
            nusd.mintAtOracle{value: 2 ether}(LOCK, voter); // exactly 100 NUSD each
            vm.prank(voter);
            nusd.approve(address(governor), type(uint256).max);
        }
        vm.deal(FUNDER, 100 ether);
        vm.prank(FUNDER);
        nusd.mintAtOracle{value: 100 ether}(0, FUNDER); // 5,000 NUSD
        vm.prank(FUNDER);
        nusd.approve(address(governor), type(uint256).max);
    }

    function _setPrice(uint256 priceWad) private {
        roundId++;
        feed.setRound(roundId, int256(priceWad), vm.getBlockTimestamp(), roundId);
    }

    function _skip(uint256 seconds_) private {
        vm.warp(vm.getBlockTimestamp() + seconds_);
    }

    /// Opens a proposal with voters[0] and has `yes - 1` more yes votes and `no` no votes.
    function _vote(uint256 yes, uint256 no) private returns (uint256 proposalId) {
        vm.prank(voters[0]);
        proposalId = governor.propose();
        for (uint256 i = 1; i < yes; ++i) {
            vm.prank(voters[i]);
            governor.vote(true);
        }
        for (uint256 i; i < no; ++i) {
            vm.prank(voters[yes + i]);
            governor.vote(false);
        }
    }

    function _endVoting() private {
        _skip(3 days);
        _setPrice(_currentPrice()); // keep the oracle fresh across the 3-day window
    }

    function _currentPrice() private view returns (uint256 price) {
        (, int256 answer,,,) = feed.latestRoundData();
        price = uint256(answer);
    }

    function testCannotProposeBelowThreeX() public {
        _setPrice(149 ether);
        vm.prank(voters[0]);
        vm.expectRevert(SurplusMintGovernor.TriggerNotReached.selector);
        governor.propose();
    }

    function testPassingVoteMintsBackToTwoXSplitBetweenPoolAndTreasury() public {
        vm.prank(FUNDER);
        governor.fundIncentives(3_000 ether);
        _setPrice(200 ether); // reserve 4x supply

        uint256 id = _vote(10, 1);
        SurplusMintGovernor.Proposal memory proposal = governor.getProposal(id);
        assertEq(proposal.yesVotes, 10, "yes votes");
        assertEq(proposal.noVotes, 1, "no votes");
        assertEq(nusd.balanceOf(address(governor)), 3_000 ether + 11 * LOCK, "locks held");

        _endVoting();
        (uint256 expected,) = nusd.surplusMintCapacity();
        governor.settle(id);

        proposal = governor.getProposal(id);
        assertTrue(proposal.settled && proposal.executed, "executed");
        assertEq(proposal.mintedNusd, expected, "minted capacity");
        assertEq(nusd.balanceOf(POOL), expected / 2, "pool half");
        assertEq(nusd.balanceOf(TREASURY), expected - expected / 2, "treasury half");
        assertLe(nusd.reserveValueNusd(), 2 * nusd.totalSupply() + 1, "back to 2x");
        assertGe(nusd.reserveValueNusd(), 2 * nusd.totalSupply(), "not below 2x");

        vm.expectRevert(SurplusMintGovernor.AlreadySettled.selector);
        governor.settle(id);
    }

    function testVotersGetLockBackPlusOneToTenNusd() public {
        vm.prank(FUNDER);
        governor.fundIncentives(3_000 ether);
        _setPrice(200 ether);
        uint256 id = _vote(10, 0);

        uint64 end = governor.getProposal(id).end;
        vm.prank(voters[1]);
        vm.expectRevert(abi.encodeWithSelector(SurplusMintGovernor.ProposalNotEnded.selector, end));
        governor.withdraw(id);

        _endVoting();
        uint256 committed;
        for (uint256 i; i < 10; ++i) {
            uint256 incentive = governor.getBallot(id, voters[i]).incentive;
            assertGe(incentive, 1 ether, "incentive floor");
            assertLe(incentive, 10 ether, "incentive cap");
            assertEq(incentive % 1 ether, 0, "whole NUSD");
            committed += incentive;
            vm.prank(voters[i]);
            governor.withdraw(id);
            assertEq(nusd.balanceOf(voters[i]), LOCK + incentive, "lock plus incentive");
        }
        assertEq(governor.incentiveCommitted(), committed, "committed ledger");
        assertEq(governor.incentiveAvailable(), 3_000 ether - committed, "budget left");

        vm.prank(voters[0]);
        vm.expectRevert(SurplusMintGovernor.AlreadyWithdrawn.selector);
        governor.withdraw(id);
        vm.prank(voters[12]);
        vm.expectRevert(SurplusMintGovernor.NoVote.selector);
        governor.withdraw(id);
    }

    function testNineVotersOrATieDoesNotMint() public {
        _setPrice(200 ether);
        uint256 id = _vote(9, 0);
        _endVoting();
        governor.settle(id);
        assertFalse(governor.getProposal(id).executed, "nine voters passed");
        for (uint256 i; i < 9; ++i) {
            vm.prank(voters[i]);
            governor.withdraw(id);
        }

        id = _vote(6, 6);
        _endVoting();
        governor.settle(id);
        assertFalse(governor.getProposal(id).executed, "tie passed");
        assertEq(nusd.balanceOf(POOL), 0, "nothing minted");
    }

    function testOneLockPerVoterAndAThreeDayWindow() public {
        _setPrice(200 ether);
        vm.prank(voters[0]);
        governor.propose();

        vm.prank(voters[0]);
        vm.expectRevert(SurplusMintGovernor.AlreadyVoted.selector);
        governor.vote(false);

        address broke = address(0xBADD);
        vm.prank(broke);
        vm.expectRevert();
        governor.vote(true);

        vm.prank(voters[1]);
        vm.expectRevert();
        governor.propose(); // the open proposal blocks a second one

        _skip(3 days);
        vm.prank(voters[1]);
        vm.expectRevert(SurplusMintGovernor.VotingClosed.selector);
        governor.vote(true);
    }

    function testSettlementRechecksTheTriggerWithAFreshPrice() public {
        _setPrice(200 ether);
        uint256 id = _vote(10, 0);
        _skip(3 days);
        _setPrice(140 ether); // reserve fell below 3x during the vote
        governor.settle(id);

        SurplusMintGovernor.Proposal memory proposal = governor.getProposal(id);
        assertTrue(proposal.settled, "settled");
        assertFalse(proposal.executed, "minted below 3x");
        assertEq(nusd.balanceOf(POOL) + nusd.balanceOf(TREASURY), 0, "nothing minted");
    }

    function testDeadOracleSettlesWithoutMintingAndLocksStayWithdrawable() public {
        _setPrice(200 ether);
        uint256 id = _vote(10, 0);
        _skip(3 days); // no price update: the oracle is stale
        governor.settle(id);
        assertFalse(governor.getProposal(id).executed, "minted on a stale price");

        vm.prank(voters[3]);
        governor.withdraw(id);
        assertEq(nusd.balanceOf(voters[3]), LOCK, "lock returned");
    }

    function testNextProposalSettlesTheEndedOne() public {
        _setPrice(200 ether);
        uint256 first = _vote(9, 0); // short of quorum
        _endVoting();

        vm.prank(voters[11]);
        uint256 second = governor.propose();
        assertEq(second, first + 1, "new id");
        assertTrue(governor.getProposal(first).settled, "auto-settled");
        assertFalse(governor.getProposal(first).executed, "failed vote executed");
        assertFalse(governor.getProposal(second).settled, "second open");
    }

    function testProposeAfterExecutedMintNeedsANewSurplus() public {
        _setPrice(200 ether);
        uint256 first = _vote(10, 0);
        _endVoting();
        governor.settle(first);

        vm.prank(voters[11]);
        vm.expectRevert(SurplusMintGovernor.TriggerNotReached.selector);
        governor.propose();
    }

    function testIncentiveBudgetIsCappedAndRunsDry() public {
        vm.prank(FUNDER);
        vm.expectRevert(abi.encodeWithSelector(SurplusMintGovernor.IncentiveBudgetExceeded.selector, 3_000 ether));
        governor.fundIncentives(3_000 ether + 1);

        vm.prank(FUNDER);
        governor.fundIncentives(5 ether);
        _setPrice(200 ether);
        uint256 id = _vote(12, 0);

        assertLe(governor.incentiveCommitted(), 5 ether, "overcommitted");
        assertEq(governor.incentiveAvailable(), 5 ether - governor.incentiveCommitted(), "available");
        _endVoting();
        uint256 paid;
        for (uint256 i; i < 12; ++i) {
            paid += governor.getBallot(id, voters[i]).incentive;
            vm.prank(voters[i]);
            governor.withdraw(id);
        }
        assertLe(paid, 5 ether, "paid beyond the budget");
        assertEq(nusd.balanceOf(address(governor)), 5 ether - paid, "only unspent budget remains");

        vm.prank(FUNDER);
        governor.fundIncentives(2_995 ether);
        vm.prank(FUNDER);
        vm.expectRevert(abi.encodeWithSelector(SurplusMintGovernor.IncentiveBudgetExceeded.selector, 0));
        governor.fundIncentives(1);
    }

    function testConstructorRejectsBadWiring() public {
        vm.expectRevert(SurplusMintGovernor.InvalidConfiguration.selector);
        new SurplusMintGovernor(IERC20(address(nusd)), POOL, POOL);
        vm.expectRevert(SurplusMintGovernor.InvalidConfiguration.selector);
        new SurplusMintGovernor(IERC20(address(0xDEAD)), POOL, TREASURY);
        vm.expectRevert(SurplusMintGovernor.InvalidConfiguration.selector);
        new SurplusMintGovernor(IERC20(address(nusd)), address(0), TREASURY);
    }
}
