// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface ISurplusMintableNusd {
    function surplusMintCapacity() external view returns (uint256 amountNusd, bool triggerReached);
    function mintSurplus(address firstRecipient, address secondRecipient, uint256 amountNusd) external;
}

/// @title NUSD surplus-mint community vote
/// @notice When the zkLTC reserve is worth at least 3x the NUSD supply, the community may vote to
///         mint NUSD until the reserve is worth exactly 2x supply. Minted NUSD goes 50% to the
///         staker reward pool and 50% to the treasury.
///
/// - Voting requires locking exactly 100 NUSD for the vote; the lock is returned afterwards,
///   so the same NUSD cannot vote twice in one proposal.
/// - A proposal lasts 3 days and passes with more yes than no votes and at least 10 voters.
///   Anyone may settle it; settlement re-checks the 3x trigger with a fresh price.
/// - Each voter receives a 1-10 NUSD incentive while the 3,000 NUSD incentive budget lasts.
///   The draw uses `prevrandao` and is NOT secure randomness; amounts are deliberately small.
/// - No owner: nothing here can be changed after deployment.
contract SurplusMintGovernor is ReentrancyGuard {
    using SafeERC20 for IERC20;

    error InvalidConfiguration();
    error TriggerNotReached();
    error ProposalStillOpen(uint256 endsAt);
    error NoOpenProposal();
    error VotingClosed();
    error AlreadyVoted();
    error ProposalNotEnded(uint256 endsAt);
    error AlreadySettled();
    error NoVote();
    error AlreadyWithdrawn();
    error IncentiveBudgetExceeded(uint256 remaining);
    error InvalidAmount();
    error NonExactTransfer();

    uint256 public constant VOTE_LOCK = 100e18;
    uint256 public constant VOTING_PERIOD = 3 days;
    uint256 public constant MIN_VOTERS = 10;
    uint256 public constant INCENTIVE_BUDGET = 3_000e18;
    uint256 public constant MAX_INCENTIVE_UNITS = 10;
    uint256 public constant INCENTIVE_UNIT = 1e18;

    struct Proposal {
        address proposer;
        uint64 start;
        uint64 end;
        uint32 yesVotes;
        uint32 noVotes;
        bool settled;
        bool executed;
        uint256 mintedNusd;
    }

    struct Ballot {
        bool cast;
        bool support;
        bool withdrawn;
        uint256 incentive;
    }

    IERC20 public immutable nusd;
    address public immutable rewardPool;
    address public immutable treasury;

    uint256 public proposalCount;
    uint256 public incentiveFunded;
    uint256 public incentiveCommitted;
    mapping(uint256 => Proposal) private _proposals;
    mapping(uint256 => mapping(address => Ballot)) private _ballots;

    event IncentivesFunded(address indexed funder, uint256 amount, uint256 totalFunded);
    event ProposalCreated(uint256 indexed proposalId, address indexed proposer, uint64 start, uint64 end);
    event VoteCast(uint256 indexed proposalId, address indexed voter, bool support, uint256 incentive);
    event ProposalSettled(uint256 indexed proposalId, bool passed, bool executed, uint256 mintedNusd);
    event VoteWithdrawn(uint256 indexed proposalId, address indexed voter, uint256 lockReturned, uint256 incentivePaid);

    constructor(IERC20 nusdToken, address rewardPoolAddress, address treasuryAddress) {
        if (
            address(nusdToken).code.length == 0 || rewardPoolAddress == address(0) || treasuryAddress == address(0)
                || rewardPoolAddress == treasuryAddress
        ) revert InvalidConfiguration();
        nusd = nusdToken;
        rewardPool = rewardPoolAddress;
        treasury = treasuryAddress;
    }

    /// @notice Adds NUSD to the voter-incentive budget, up to 3,000 NUSD in total. Anyone may fund.
    function fundIncentives(uint256 amount) external nonReentrant {
        if (amount == 0) revert InvalidAmount();
        uint256 remaining = INCENTIVE_BUDGET - incentiveFunded;
        if (amount > remaining) revert IncentiveBudgetExceeded(remaining);
        _pullExact(msg.sender, amount);
        incentiveFunded += amount;
        emit IncentivesFunded(msg.sender, amount, incentiveFunded);
    }

    /// @notice Opens a proposal (and votes yes with the proposer's 100 NUSD) once reserve >= 3x supply.
    function propose() external nonReentrant returns (uint256 proposalId) {
        uint256 previous = proposalCount;
        if (previous != 0) {
            Proposal storage last = _proposals[previous];
            if (!last.settled) {
                // forge-lint: disable-next-line(block-timestamp)
                if (block.timestamp < last.end) revert ProposalStillOpen(last.end);
                _settle(previous);
            }
        }
        (, bool triggerReached) = ISurplusMintableNusd(address(nusd)).surplusMintCapacity();
        if (!triggerReached) revert TriggerNotReached();

        proposalId = previous + 1;
        proposalCount = proposalId;
        uint64 start = uint64(block.timestamp);
        // forge-lint: disable-next-line(unsafe-typecast)
        uint64 end = uint64(block.timestamp + VOTING_PERIOD);
        _proposals[proposalId] = Proposal(msg.sender, start, end, 0, 0, false, false, 0);
        emit ProposalCreated(proposalId, msg.sender, start, end);
        _castVote(proposalId, msg.sender, true);
    }

    function vote(bool support) external nonReentrant {
        uint256 proposalId = proposalCount;
        if (proposalId == 0) revert NoOpenProposal();
        Proposal storage proposal = _proposals[proposalId];
        // forge-lint: disable-next-line(block-timestamp)
        if (proposal.settled || block.timestamp >= proposal.end) revert VotingClosed();
        _castVote(proposalId, msg.sender, support);
    }

    /// @notice Closes an ended proposal and, if it passed and the reserve is still >= 3x, mints.
    function settle(uint256 proposalId) external nonReentrant {
        Proposal storage proposal = _proposals[proposalId];
        if (proposal.start == 0) revert NoOpenProposal();
        if (proposal.settled) revert AlreadySettled();
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp < proposal.end) revert ProposalNotEnded(proposal.end);
        _settle(proposalId);
    }

    /// @notice Returns the voter's 100 NUSD plus their incentive once voting has ended.
    function withdraw(uint256 proposalId) external nonReentrant {
        Proposal storage proposal = _proposals[proposalId];
        // forge-lint: disable-next-line(block-timestamp)
        if (proposal.start == 0 || block.timestamp < proposal.end) revert ProposalNotEnded(proposal.end);
        Ballot storage ballot = _ballots[proposalId][msg.sender];
        if (!ballot.cast) revert NoVote();
        if (ballot.withdrawn) revert AlreadyWithdrawn();
        ballot.withdrawn = true;
        nusd.safeTransfer(msg.sender, VOTE_LOCK + ballot.incentive);
        emit VoteWithdrawn(proposalId, msg.sender, VOTE_LOCK, ballot.incentive);
    }

    function getProposal(uint256 proposalId) external view returns (Proposal memory) {
        return _proposals[proposalId];
    }

    function getBallot(uint256 proposalId, address voter) external view returns (Ballot memory) {
        return _ballots[proposalId][voter];
    }

    function incentiveAvailable() public view returns (uint256) {
        return incentiveFunded - incentiveCommitted;
    }

    function _castVote(uint256 proposalId, address voter, bool support) private {
        Ballot storage ballot = _ballots[proposalId][voter];
        if (ballot.cast) revert AlreadyVoted();
        _pullExact(voter, VOTE_LOCK);

        // Not secure randomness: a small, bounded incentive only.
        uint256 units = 1 + uint256(keccak256(abi.encode(block.prevrandao, block.timestamp, proposalId, voter))) % MAX_INCENTIVE_UNITS;
        uint256 incentive = units * INCENTIVE_UNIT;
        uint256 available = incentiveAvailable();
        if (incentive > available) incentive = available;
        incentiveCommitted += incentive;

        _ballots[proposalId][voter] = Ballot(true, support, false, incentive);
        Proposal storage proposal = _proposals[proposalId];
        if (support) proposal.yesVotes += 1;
        else proposal.noVotes += 1;
        emit VoteCast(proposalId, voter, support, incentive);
    }

    function _settle(uint256 proposalId) private {
        Proposal storage proposal = _proposals[proposalId];
        proposal.settled = true;
        uint256 voters = uint256(proposal.yesVotes) + proposal.noVotes;
        bool passed = proposal.yesVotes > proposal.noVotes && voters >= MIN_VOTERS;
        if (passed) {
            // A dead oracle, a reserve that fell below 3x, or a full supply ceiling simply mints nothing.
            try ISurplusMintableNusd(address(nusd)).surplusMintCapacity() returns (uint256 amount, bool triggerReached) {
                if (triggerReached && amount != 0) {
                    ISurplusMintableNusd(address(nusd)).mintSurplus(rewardPool, treasury, amount);
                    proposal.executed = true;
                    proposal.mintedNusd = amount;
                }
            } catch {}
        }
        emit ProposalSettled(proposalId, passed, proposal.executed, proposal.mintedNusd);
    }

    function _pullExact(address from, uint256 amount) private {
        uint256 balanceBefore = nusd.balanceOf(address(this));
        nusd.safeTransferFrom(from, address(this), amount);
        if (nusd.balanceOf(address(this)) != balanceBefore + amount) revert NonExactTransfer();
    }
}
