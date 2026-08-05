// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";

contract LiquidityGauge is ReentrancyGuard {
    using SafeERC20 for IERC20;

    error DepositsPaused();
    error FeeOnTransferUnsupported();
    error InvalidAmount();
    error InvalidDuration();
    error UnauthorizedDistributor();
    error UnfundedSchedule();

    uint256 public constant PRECISION = 1e18;
    uint256 public constant MIN_REWARD_DURATION = 1 days;
    uint256 public constant MAX_REWARD_DURATION = 365 days;

    IERC20 public immutable stakingToken;
    IERC20 public immutable rewardToken;
    address public immutable distributor;

    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;

    uint256 public periodFinish;
    uint256 public rewardRate;
    uint256 public lastUpdateTime;
    uint256 public rewardPerTokenStored;
    uint256 public pausedRewardDuration;
    mapping(address => uint256) public userRewardPerTokenPaid;
    mapping(address => uint256) public rewards;

    uint256 public totalFunded;
    uint256 public totalPaid;
    bool public depositsPaused;

    event Staked(address indexed account, uint256 amount);
    event Withdrawn(address indexed account, uint256 amount);
    event RewardPaid(address indexed account, uint256 reward);
    event RewardAdded(uint256 amount, uint256 duration, uint256 rewardRate, uint256 periodFinish);
    event RewardSchedulePaused(uint256 remainingDuration);
    event RewardScheduleResumed(uint256 periodFinish);
    event DepositsPauseUpdated(bool paused);

    constructor(address stakingToken_, address rewardToken_, address distributor_) {
        if (stakingToken_.code.length == 0 || rewardToken_.code.length == 0 || distributor_.code.length == 0) {
            revert InvalidAmount();
        }
        stakingToken = IERC20(stakingToken_);
        rewardToken = IERC20(rewardToken_);
        distributor = distributor_;
    }

    modifier onlyDistributor() {
        if (msg.sender != distributor) revert UnauthorizedDistributor();
        _;
    }

    modifier updateReward(address account) {
        rewardPerTokenStored = rewardPerToken();
        lastUpdateTime = lastTimeRewardApplicable();
        if (account != address(0)) {
            rewards[account] = earned(account);
            userRewardPerTokenPaid[account] = rewardPerTokenStored;
        }
        _;
    }

    function lastTimeRewardApplicable() public view returns (uint256) {
        // Reward schedules are explicitly timestamp-based and bounded by periodFinish.
        // forge-lint: disable-next-line(block-timestamp)
        return block.timestamp < periodFinish ? block.timestamp : periodFinish;
    }

    function rewardPerToken() public view returns (uint256) {
        if (totalSupply == 0) return rewardPerTokenStored;
        return rewardPerTokenStored
            + Math.mulDiv(lastTimeRewardApplicable() - lastUpdateTime, rewardRate * PRECISION, totalSupply);
    }

    function earned(address account) public view returns (uint256) {
        return Math.mulDiv(balanceOf[account], rewardPerToken() - userRewardPerTokenPaid[account], PRECISION)
            + rewards[account];
    }

    function stake(uint256 amount) external nonReentrant updateReward(msg.sender) {
        if (depositsPaused) revert DepositsPaused();
        if (amount == 0) revert InvalidAmount();
        bool resumesRewards = totalSupply == 0 && pausedRewardDuration != 0;
        totalSupply += amount;
        balanceOf[msg.sender] += amount;
        _safeTransferFromExact(stakingToken, msg.sender, address(this), amount);
        if (resumesRewards) _resumeRewardSchedule();
        emit Staked(msg.sender, amount);
    }

    function withdraw(uint256 amount) public nonReentrant updateReward(msg.sender) {
        if (amount == 0 || amount > balanceOf[msg.sender]) revert InvalidAmount();
        totalSupply -= amount;
        balanceOf[msg.sender] -= amount;
        _safeTransferExact(stakingToken, msg.sender, amount);
        if (totalSupply == 0) _pauseRewardSchedule();
        emit Withdrawn(msg.sender, amount);
    }

    function getReward() public nonReentrant updateReward(msg.sender) returns (uint256 reward) {
        reward = rewards[msg.sender];
        if (reward == 0) return 0;
        rewards[msg.sender] = 0;
        totalPaid += reward;
        _safeTransferExact(rewardToken, msg.sender, reward);
        emit RewardPaid(msg.sender, reward);
    }

    function exit() external {
        uint256 staked = balanceOf[msg.sender];
        if (staked != 0) withdraw(staked);
        getReward();
    }

    function notifyRewardAmount(uint256 amount, uint256 duration) external onlyDistributor updateReward(address(0)) {
        if (amount == 0) revert InvalidAmount();
        if (duration < MIN_REWARD_DURATION || duration > MAX_REWARD_DURATION) revert InvalidDuration();
        if (rewardToken.balanceOf(address(this)) + totalPaid < totalFunded + amount) revert UnfundedSchedule();

        uint256 distributable = amount;
        // Remaining funded rewards are calculated from the same timestamp schedule.
        if (pausedRewardDuration != 0) {
            distributable += pausedRewardDuration * rewardRate;
        } else {
            // forge-lint: disable-next-line(block-timestamp)
            if (block.timestamp < periodFinish) {
                distributable += (periodFinish - block.timestamp) * rewardRate;
            }
        }
        uint256 newRewardRate = distributable / duration;
        if (newRewardRate == 0) revert InvalidAmount();

        totalFunded += amount;
        rewardRate = newRewardRate;
        lastUpdateTime = block.timestamp;
        if (totalSupply == 0) {
            pausedRewardDuration = duration;
            periodFinish = block.timestamp;
            emit RewardSchedulePaused(duration);
        } else {
            pausedRewardDuration = 0;
            periodFinish = block.timestamp + duration;
        }
        emit RewardAdded(amount, duration, newRewardRate, periodFinish);
    }

    function setDepositsPaused(bool paused) external onlyDistributor {
        depositsPaused = paused;
        emit DepositsPauseUpdated(paused);
    }

    function _safeTransferFromExact(IERC20 token, address from, address to, uint256 amount) private {
        uint256 balanceBefore = token.balanceOf(to);
        token.safeTransferFrom(from, to, amount);
        if (token.balanceOf(to) != balanceBefore + amount) revert FeeOnTransferUnsupported();
    }

    function _safeTransferExact(IERC20 token, address to, uint256 amount) private {
        uint256 balanceBefore = token.balanceOf(to);
        token.safeTransfer(to, amount);
        if (token.balanceOf(to) != balanceBefore + amount) revert FeeOnTransferUnsupported();
    }

    function _pauseRewardSchedule() private {
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp >= periodFinish) return;
        pausedRewardDuration = periodFinish - block.timestamp;
        periodFinish = block.timestamp;
        emit RewardSchedulePaused(pausedRewardDuration);
    }

    function _resumeRewardSchedule() private {
        uint256 remainingDuration = pausedRewardDuration;
        pausedRewardDuration = 0;
        lastUpdateTime = block.timestamp;
        periodFinish = block.timestamp + remainingDuration;
        emit RewardScheduleResumed(periodFinish);
    }
}
