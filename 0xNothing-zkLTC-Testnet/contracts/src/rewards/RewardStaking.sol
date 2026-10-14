// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";

/// @title 0xPoints staking and reward rounds
/// @notice Stake NUSD to earn 0xPoints; 0xPoints decide each staker's share of a reward round.
///
/// - 0xPoints accrue every second at `amount x lockMultiplier`, so a stake made just before a
///   round closes earns almost nothing for that round.
/// - The reward pool is every NUSD this contract holds beyond principal and already-allocated
///   rewards. Anyone may `trigger()` once the pool holds at least 10,000 NUSD and the round
///   has lasted a day: the round closes and exactly 10,000 NUSD is split pro rata to the
///   round's 0xPoints. Points reset for the next round; any extra NUSD rolls over.
/// - Claims are pull-based and never expire. Principal can always be withdrawn after the
///   lock ends. There is no owner, no pause and no way to move principal or rewards.
contract RewardStaking is ReentrancyGuard {
    using SafeERC20 for IERC20;

    error InvalidConfiguration();
    error InvalidAmount();
    error InvalidLockDuration();
    error InvalidRecipient();
    error UnknownPosition();
    error NotPositionOwner();
    error PositionLocked(uint64 unlockTime);
    error AlreadyWithdrawn();
    error RoundTooShort(uint256 availableAt);
    error PoolBelowThreshold(uint256 availableNusd);
    error NoPointsInRound();
    error NothingToClaim();
    error NonExactTransfer();

    uint256 public constant BPS = 10_000;
    uint256 public constant ROUND_REWARD = 10_000e18;
    uint256 public constant MIN_ROUND_DURATION = 1 days;
    uint256 private constant PRECISION = 1e36;
    uint32 public constant LOCK_30_DAYS = 30 days;
    uint32 public constant LOCK_90_DAYS = 90 days;
    uint32 public constant LOCK_180_DAYS = 180 days;
    uint32 public constant LOCK_365_DAYS = 365 days;

    struct Position {
        address account;
        uint64 unlockTime;
        uint32 lockDuration;
        bool withdrawn;
        uint256 amount;
        uint256 weight;
    }

    /// @dev Lazy checkpoint: points earned in `anchorRound` up to `anchorTime`, plus settled rewards.
    struct Account {
        uint256 weight;
        uint256 anchorPoints;
        uint256 pendingReward;
        uint64 anchorTime;
        uint32 anchorRound;
    }

    IERC20 public immutable nusd;

    uint256 public totalWeight;
    uint256 public totalPrincipal;
    uint256 public totalAllocatedUnpaid;
    uint256 public currentRoundPoints;
    uint64 public lastGlobalUpdate;
    uint32 public currentRound;
    uint256 public nextPositionId = 1;

    mapping(uint256 => uint64) public roundStart;
    mapping(uint256 => uint256) public roundTotalPoints;
    /// @dev Reward per point, scaled by PRECISION, for each closed round.
    mapping(uint256 => uint256) public roundRate;
    /// @dev Prefix sum of `rate x duration` over closed rounds: reward per unit weight held for whole rounds.
    mapping(uint256 => uint256) private _fullRoundIndex;
    mapping(uint256 => Position) private _positions;
    mapping(address => uint256[]) private _positionIds;
    mapping(address => Account) private _accounts;

    event Staked(uint256 indexed positionId, address indexed account, uint256 amount, uint256 weight, uint32 lockDuration, uint64 unlockTime);
    event Withdrawn(uint256 indexed positionId, address indexed account, uint256 amount);
    event RoundClosed(uint256 indexed round, address indexed caller, uint256 totalPoints, uint256 reward, uint64 start, uint64 end);
    event RewardClaimed(address indexed account, address indexed recipient, uint256 amount);

    constructor(IERC20 nusdToken) {
        if (address(nusdToken).code.length == 0) revert InvalidConfiguration();
        nusd = nusdToken;
        roundStart[0] = uint64(block.timestamp);
        lastGlobalUpdate = uint64(block.timestamp);
    }

    // ---------------------------------------------------------------- staking

    function stake(uint256 amount, uint32 lockDuration) external nonReentrant returns (uint256 positionId) {
        if (amount == 0) revert InvalidAmount();
        uint256 weight = Math.mulDiv(amount, lockMultiplierBps(lockDuration), BPS);
        _updateGlobal();
        Account storage account = _checkpoint(msg.sender);

        uint256 balanceBefore = nusd.balanceOf(address(this));
        nusd.safeTransferFrom(msg.sender, address(this), amount);
        if (nusd.balanceOf(address(this)) != balanceBefore + amount) revert NonExactTransfer();

        uint64 unlockTime = uint64(block.timestamp + lockDuration);
        positionId = nextPositionId++;
        _positions[positionId] = Position(msg.sender, unlockTime, lockDuration, false, amount, weight);
        _positionIds[msg.sender].push(positionId);
        account.weight += weight;
        totalWeight += weight;
        totalPrincipal += amount;
        emit Staked(positionId, msg.sender, amount, weight, lockDuration, unlockTime);
    }

    function withdraw(uint256 positionId) external nonReentrant {
        Position storage position = _positions[positionId];
        if (position.account == address(0)) revert UnknownPosition();
        if (position.account != msg.sender) revert NotPositionOwner();
        if (position.withdrawn) revert AlreadyWithdrawn();
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp < position.unlockTime) revert PositionLocked(position.unlockTime);

        _updateGlobal();
        Account storage account = _checkpoint(msg.sender);
        position.withdrawn = true;
        account.weight -= position.weight;
        totalWeight -= position.weight;
        totalPrincipal -= position.amount;
        nusd.safeTransfer(msg.sender, position.amount);
        emit Withdrawn(positionId, msg.sender, position.amount);
    }

    // ---------------------------------------------------------------- rounds

    /// @notice Closes the current round and allocates exactly 10,000 NUSD to it. Permissionless.
    function trigger() external nonReentrant {
        _updateGlobal();
        uint32 round = currentRound;
        uint64 start = roundStart[round];
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp < uint256(start) + MIN_ROUND_DURATION) revert RoundTooShort(uint256(start) + MIN_ROUND_DURATION);
        uint256 available = availableRewards();
        if (available < ROUND_REWARD) revert PoolBelowThreshold(available);
        uint256 points = currentRoundPoints;
        if (points == 0) revert NoPointsInRound();

        uint256 rate = Math.mulDiv(ROUND_REWARD, PRECISION, points);
        uint64 end = uint64(block.timestamp);
        roundTotalPoints[round] = points;
        roundRate[round] = rate;
        _fullRoundIndex[round] = (round == 0 ? 0 : _fullRoundIndex[round - 1]) + rate * (end - start);
        totalAllocatedUnpaid += ROUND_REWARD;

        currentRound = round + 1;
        roundStart[round + 1] = end;
        currentRoundPoints = 0;
        emit RoundClosed(round, msg.sender, points, ROUND_REWARD, start, end);
    }

    function claim(address recipient) external nonReentrant returns (uint256 amount) {
        if (recipient == address(0)) revert InvalidRecipient();
        _updateGlobal();
        Account storage account = _checkpoint(msg.sender);
        amount = account.pendingReward;
        if (amount == 0) revert NothingToClaim();
        account.pendingReward = 0;
        totalAllocatedUnpaid -= amount;
        nusd.safeTransfer(recipient, amount);
        emit RewardClaimed(msg.sender, recipient, amount);
    }

    // ---------------------------------------------------------------- views

    function lockMultiplierBps(uint32 lockDuration) public pure returns (uint256) {
        if (lockDuration == LOCK_30_DAYS) return 10_000;
        if (lockDuration == LOCK_90_DAYS) return 12_000;
        if (lockDuration == LOCK_180_DAYS) return 15_000;
        if (lockDuration == LOCK_365_DAYS) return 30_000;
        revert InvalidLockDuration();
    }

    /// @notice Unallocated NUSD in the pool (balance minus principal minus allocated-but-unclaimed).
    function availableRewards() public view returns (uint256) {
        uint256 balance = nusd.balanceOf(address(this));
        uint256 reserved = totalPrincipal + totalAllocatedUnpaid;
        return balance > reserved ? balance - reserved : 0;
    }

    /// @notice Timestamp from which `trigger()` is allowed (if the pool is also funded).
    function nextTriggerTime() external view returns (uint256) {
        return uint256(roundStart[currentRound]) + MIN_ROUND_DURATION;
    }

    /// @notice Total 0xPoints accrued in the open round so far.
    function openRoundPoints() public view returns (uint256) {
        return currentRoundPoints + totalWeight * (block.timestamp - lastGlobalUpdate);
    }

    /// @notice An account's 0xPoints in the open round and its claimable reward from closed rounds.
    function accountState(address user) external view returns (uint256 weight, uint256 openPoints, uint256 claimable) {
        Account memory account = _accounts[user];
        weight = account.weight;
        if (account.anchorTime == 0) return (weight, 0, 0);
        (claimable, openPoints) = _settle(account, uint64(block.timestamp));
    }

    function getPosition(uint256 positionId) external view returns (Position memory) {
        return _positions[positionId];
    }

    function positionIdsOf(address user) external view returns (uint256[] memory) {
        return _positionIds[user];
    }

    // ---------------------------------------------------------------- internals

    function _updateGlobal() private {
        uint64 now_ = uint64(block.timestamp);
        currentRoundPoints += totalWeight * (now_ - lastGlobalUpdate);
        lastGlobalUpdate = now_;
    }

    /// @dev Must run after `_updateGlobal()` and before any change to the account's weight.
    function _checkpoint(address user) private returns (Account storage account) {
        account = _accounts[user];
        uint64 now_ = uint64(block.timestamp);
        if (account.anchorTime == 0) {
            account.anchorRound = currentRound;
            account.anchorTime = now_;
            return account;
        }
        (uint256 pending, uint256 openPoints) = _settle(account, now_);
        account.pendingReward = pending;
        account.anchorPoints = openPoints;
        account.anchorRound = currentRound;
        account.anchorTime = now_;
    }

    /// @dev Rewards from every round closed since the anchor, and points earned in the open round by `now_`.
    function _settle(Account memory account, uint64 now_) private view returns (uint256 pending, uint256 openPoints) {
        pending = account.pendingReward;
        uint32 round = currentRound;
        uint32 anchor = account.anchorRound;
        if (anchor == round) {
            return (pending, account.anchorPoints + account.weight * (now_ - account.anchorTime));
        }
        // Remainder of the (closed) anchor round.
        uint256 points = account.anchorPoints + account.weight * (roundStart[anchor + 1] - account.anchorTime);
        pending += Math.mulDiv(points, roundRate[anchor], PRECISION);
        // Whole closed rounds strictly between the anchor round and the open round.
        if (round - 1 > anchor) {
            pending += Math.mulDiv(account.weight, _fullRoundIndex[round - 1] - _fullRoundIndex[anchor], PRECISION);
        }
        openPoints = account.weight * (now_ - roundStart[round]);
    }
}
