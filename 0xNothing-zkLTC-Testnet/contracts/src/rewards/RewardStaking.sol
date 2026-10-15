// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "../common/ReentrancyGuard.sol";

interface IRewardHarvester {
    function harvest() external returns (uint256 sourcesSucceeded);
}

/// @title 0xPoints staking
/// @notice Lock NUSD for 30/90/180/365 days (weight x1 / x1.2 / x1.5 / x3) and earn every NUSD
///         that reaches this contract: protocol fees, NUSD surplus, donations. Income needs no
///         notification: anything held beyond principal and owed rewards is picked up on the next
///         interaction and streamed evenly over the following 7 days, pro rata to weight. While
///         nobody is staked the stream pauses instead of being lost.
/// @dev No admin, no rounds, no thresholds. A position's principal can always be withdrawn after
///      its unlock time, and withdrawal never runs the fee harvest, so nothing outside NUSD can block it.
contract RewardStaking is ReentrancyGuard {
    using SafeERC20 for IERC20;

    error InvalidAmount();
    error InvalidLockDuration();
    error UnknownPosition();
    error NotPositionOwner();
    error AlreadyWithdrawn();
    error PositionLocked(uint256 unlockTime);
    error NothingToClaim();
    error InvalidRecipient();
    error NonExactTransfer();
    error Unauthorized();
    error HarvesterAlreadyBound();
    error InvalidHarvester();

    uint256 public constant BPS = 10_000;
    uint256 public constant STREAM_DURATION = 7 days;
    /// @notice Gas forwarded to the fee harvest, so a slow harvest can only be skipped, never block.
    uint256 public constant HARVEST_GAS = 3_000_000;
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

    struct Account {
        uint256 weight;
        uint256 rewardPerWeightPaid;
        uint256 pendingReward;
        /// @dev Lifetime 0xPoints: weight x seconds staked.
        uint256 points;
        uint64 checkpointAt;
    }

    IERC20 public immutable nusd;
    address private immutable _binder;

    // Packed: read together on every interaction.
    address public harvester;
    uint64 public lastUpdate;
    uint64 public periodFinish;

    uint256 public totalWeight;
    uint256 public totalPrincipal;
    /// @notice Lifetime 0xPoints of everyone, as of `lastUpdate`.
    uint256 public totalPoints;
    uint256 public rewardPerWeightStored;
    /// @dev NUSD wei per second, scaled by PRECISION.
    uint256 public rewardRateScaled;
    /// @dev NUSD wei committed to the stream but not streamed yet, scaled by PRECISION.
    uint256 public unstreamedScaled;
    /// @notice Every NUSD ever recognised as reward income, and every NUSD paid out of it.
    uint256 public rewardFunded;
    uint256 public rewardPaid;
    uint256 public nextPositionId = 1;

    mapping(uint256 => Position) private _positions;
    mapping(address => uint256[]) private _positionIds;
    mapping(address => Account) private _accounts;

    event Staked(
        uint256 indexed positionId,
        address indexed account,
        uint256 amount,
        uint256 weight,
        uint32 lockDuration,
        uint64 unlockTime
    );
    event Withdrawn(uint256 indexed positionId, address indexed account, uint256 amount);
    event RewardClaimed(address indexed account, address indexed recipient, uint256 amount);
    event RewardRestaked(address indexed account, uint256 indexed positionId, uint256 amount);
    event RewardsQueued(uint256 income, uint256 rewardRatePerSecond, uint256 periodFinish);
    event HarvesterBound(address indexed harvester);

    constructor(IERC20 nusd_) {
        if (address(nusd_).code.length == 0) revert InvalidAmount();
        nusd = nusd_;
        _binder = msg.sender;
        lastUpdate = uint64(block.timestamp);
        periodFinish = uint64(block.timestamp);
    }

    /// @notice Binds the fee harvest run before stakes and claims. Once, by the deployer.
    function bindHarvester(address harvester_) external {
        if (msg.sender != _binder) revert Unauthorized();
        if (harvester != address(0)) revert HarvesterAlreadyBound();
        if (harvester_.code.length == 0) revert InvalidHarvester();
        harvester = harvester_;
        emit HarvesterBound(harvester_);
    }

    // ---------------------------------------------------------------- positions

    function stake(uint256 amount, uint32 lockDuration) external nonReentrant returns (uint256 positionId) {
        if (amount == 0) revert InvalidAmount();
        uint256 multiplierBps = lockMultiplierBps(lockDuration);
        _harvest();
        Account storage account = _checkpoint(msg.sender);

        uint256 balanceBefore = nusd.balanceOf(address(this));
        nusd.safeTransferFrom(msg.sender, address(this), amount);
        if (nusd.balanceOf(address(this)) != balanceBefore + amount) revert NonExactTransfer();

        positionId = _open(msg.sender, account, amount, lockDuration, multiplierBps);
    }

    /// @notice Claims every earned reward into a new position instead of the wallet.
    function claimAndStake(uint32 lockDuration) external nonReentrant returns (uint256 positionId) {
        uint256 multiplierBps = lockMultiplierBps(lockDuration);
        _harvest();
        Account storage account = _checkpoint(msg.sender);
        uint256 amount = account.pendingReward;
        if (amount == 0) revert NothingToClaim();
        account.pendingReward = 0;
        // Reward liability becomes principal: the NUSD never leaves the contract.
        rewardPaid += amount;
        positionId = _open(msg.sender, account, amount, lockDuration, multiplierBps);
        emit RewardRestaked(msg.sender, positionId, amount);
    }

    /// @notice Returns an unlocked position's principal. Never runs the fee harvest.
    function withdraw(uint256 positionId) external nonReentrant {
        Position storage position = _positions[positionId];
        if (position.account == address(0)) revert UnknownPosition();
        if (position.account != msg.sender) revert NotPositionOwner();
        if (position.withdrawn) revert AlreadyWithdrawn();
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp < position.unlockTime) revert PositionLocked(position.unlockTime);

        Account storage account = _checkpoint(msg.sender);
        position.withdrawn = true;
        account.weight -= position.weight;
        totalWeight -= position.weight;
        totalPrincipal -= position.amount;
        nusd.safeTransfer(msg.sender, position.amount);
        emit Withdrawn(positionId, msg.sender, position.amount);
    }

    function claim(address recipient) external nonReentrant returns (uint256 amount) {
        if (recipient == address(0)) revert InvalidRecipient();
        _harvest();
        Account storage account = _checkpoint(msg.sender);
        amount = account.pendingReward;
        if (amount == 0) revert NothingToClaim();
        account.pendingReward = 0;
        rewardPaid += amount;
        nusd.safeTransfer(recipient, amount);
        emit RewardClaimed(msg.sender, recipient, amount);
    }

    /// @notice Harvests fees and starts streaming any new income now. Permissionless.
    function sync() external nonReentrant {
        _harvest();
        _updateGlobal();
    }

    // ---------------------------------------------------------------- views

    function lockMultiplierBps(uint32 lockDuration) public pure returns (uint256) {
        if (lockDuration == LOCK_30_DAYS) return 10_000;
        if (lockDuration == LOCK_90_DAYS) return 12_000;
        if (lockDuration == LOCK_180_DAYS) return 15_000;
        if (lockDuration == LOCK_365_DAYS) return 30_000;
        revert InvalidLockDuration();
    }

    /// @notice Reward the account could claim now (income not picked up yet is not included).
    function earned(address user) public view returns (uint256) {
        Account storage account = _accounts[user];
        return account.pendingReward
            + account.weight * (_currentRewardPerWeight() - account.rewardPerWeightPaid) / PRECISION;
    }

    /// @notice Lifetime 0xPoints of `user` as of now.
    function pointsOf(address user) public view returns (uint256) {
        Account storage account = _accounts[user];
        return account.points + account.weight * (block.timestamp - account.checkpointAt);
    }

    /// @notice Lifetime 0xPoints of everyone as of now.
    function totalPointsNow() external view returns (uint256) {
        return totalPoints + totalWeight * (block.timestamp - lastUpdate);
    }

    /// @notice Weight (0xPoints per second), lifetime 0xPoints and claimable reward.
    function accountState(address user) external view returns (uint256 weight, uint256 points, uint256 claimable) {
        return (_accounts[user].weight, pointsOf(user), earned(user));
    }

    /// @notice NUSD streamed to stakers per second right now.
    function rewardRate() external view returns (uint256) {
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp >= periodFinish || totalWeight == 0) return 0;
        return rewardRateScaled / PRECISION;
    }

    /// @notice NUSD still to be streamed, including income not picked up yet.
    function queuedRewards() external view returns (uint256) {
        uint256 pending = unstreamedScaled / PRECISION;
        uint256 finish = periodFinish;
        uint256 last = lastUpdate;
        if (totalWeight != 0 && finish > last) {
            // forge-lint: disable-next-line(block-timestamp)
            uint256 end = block.timestamp < finish ? block.timestamp : finish;
            uint256 streamed = rewardRateScaled * (end - last) / PRECISION;
            pending = pending > streamed ? pending - streamed : 0;
        }
        return pending + _unrecognisedIncome();
    }

    function getPosition(uint256 positionId) external view returns (Position memory) {
        return _positions[positionId];
    }

    function positionIdsOf(address user) external view returns (uint256[] memory) {
        return _positionIds[user];
    }

    // ---------------------------------------------------------------- internals

    function _open(address owner, Account storage account, uint256 amount, uint32 lockDuration, uint256 multiplierBps)
        private
        returns (uint256 positionId)
    {
        uint256 weight = amount * multiplierBps / BPS;
        if (weight == 0) revert InvalidAmount();
        uint64 unlockTime = uint64(block.timestamp + lockDuration);
        positionId = nextPositionId++;
        _positions[positionId] = Position(owner, unlockTime, lockDuration, false, amount, weight);
        _positionIds[owner].push(positionId);
        account.weight += weight;
        totalWeight += weight;
        totalPrincipal += amount;
        emit Staked(positionId, owner, amount, weight, lockDuration, unlockTime);
    }

    function _harvest() private {
        address target = harvester;
        if (target == address(0)) return;
        try IRewardHarvester(target).harvest{gas: HARVEST_GAS}() {} catch {}
    }

    function _checkpoint(address user) private returns (Account storage account) {
        _updateGlobal();
        account = _accounts[user];
        uint256 rewardPerWeight = rewardPerWeightStored;
        uint256 weight = account.weight;
        if (weight != 0) {
            account.pendingReward += weight * (rewardPerWeight - account.rewardPerWeightPaid) / PRECISION;
            account.points += weight * (block.timestamp - account.checkpointAt);
        }
        account.rewardPerWeightPaid = rewardPerWeight;
        account.checkpointAt = uint64(block.timestamp);
    }

    /// @dev Advances the stream to now, then streams any new income over the next 7 days.
    function _updateGlobal() private {
        uint256 last = lastUpdate;
        uint256 weight = totalWeight;
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp > last) {
            totalPoints += weight * (block.timestamp - last);
            uint256 finish = periodFinish;
            if (finish > last) {
                if (weight == 0) {
                    // Nobody to pay: hold the stream, keeping the time it had left.
                    // forge-lint: disable-next-line(unsafe-typecast)
                    periodFinish = uint64(block.timestamp + (finish - last));
                } else {
                    // forge-lint: disable-next-line(block-timestamp)
                    uint256 end = block.timestamp < finish ? block.timestamp : finish;
                    uint256 streamed = rewardRateScaled * (end - last);
                    rewardPerWeightStored += streamed / weight;
                    unstreamedScaled -= streamed;
                }
            }
            lastUpdate = uint64(block.timestamp);
        }

        uint256 income = _unrecognisedIncome();
        if (income != 0) {
            rewardFunded += income;
            uint256 unstreamed = unstreamedScaled + income * PRECISION;
            unstreamedScaled = unstreamed;
            rewardRateScaled = unstreamed / STREAM_DURATION;
            // forge-lint: disable-next-line(unsafe-typecast)
            periodFinish = uint64(block.timestamp + STREAM_DURATION);
            emit RewardsQueued(income, unstreamed / STREAM_DURATION / PRECISION, block.timestamp + STREAM_DURATION);
        }
    }

    function _unrecognisedIncome() private view returns (uint256) {
        uint256 balance = nusd.balanceOf(address(this));
        uint256 accounted = totalPrincipal + rewardFunded - rewardPaid;
        return balance > accounted ? balance - accounted : 0;
    }

    function _currentRewardPerWeight() private view returns (uint256 rewardPerWeight) {
        rewardPerWeight = rewardPerWeightStored;
        uint256 weight = totalWeight;
        uint256 last = lastUpdate;
        uint256 finish = periodFinish;
        if (weight != 0 && finish > last) {
            // forge-lint: disable-next-line(block-timestamp)
            uint256 end = block.timestamp < finish ? block.timestamp : finish;
            if (end > last) rewardPerWeight += rewardRateScaled * (end - last) / weight;
        }
    }
}
