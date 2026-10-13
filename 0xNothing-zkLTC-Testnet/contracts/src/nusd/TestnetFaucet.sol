// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ReentrancyGuard} from "../common/ReentrancyGuard.sol";
import {IERC20Minimal, SafeTransferLib} from "../common/SafeTransferLib.sol";
import {TwoStepAdmin} from "../common/TwoStepAdmin.sol";

/// @notice LiteForge-only drip of zkLTC and NUSD. Not for mainnet.
contract TestnetFaucet is TwoStepAdmin, ReentrancyGuard {
    error WrongChain(uint256 expectedChainId, uint256 actualChainId);
    error InvalidNusd();
    error InvalidDrip();
    error InvalidCooldown();
    error InvalidDailyCap();
    error InvalidRecipient();
    error ContractsNotAllowed();
    error FaucetPaused();
    error CooldownActive(uint256 readyAt);
    error DailyCapExceeded();
    error InsufficientNativeReserve(uint256 requiredAmount, uint256 availableAmount);
    error InsufficientNusdReserve(uint256 requiredAmount, uint256 availableAmount);

    uint256 public constant EXPECTED_CHAIN_ID = 4441;
    uint256 public constant MIN_COOLDOWN = 1 minutes;
    uint256 public constant MAX_COOLDOWN = 7 days;

    address public immutable nusd;

    uint256 public nativeDrip;
    uint256 public nusdDrip;
    uint256 public cooldownSeconds;
    uint256 public dailyNativeCap;
    uint256 public dailyNusdCap;
    uint64 public currentUtcDay;
    uint256 public dailyNativeDispensed;
    uint256 public dailyNusdDispensed;
    bool public paused;

    mapping(address => uint256) public lastClaimAt;

    event Claimed(address indexed account, uint256 nativeAmount, uint256 nusdAmount, uint64 utcDay);
    event DripUpdated(uint256 nativeDrip, uint256 nusdDrip);
    event CooldownUpdated(uint256 cooldownSeconds);
    event DailyCapsUpdated(uint256 dailyNativeCap, uint256 dailyNusdCap);
    event PauseUpdated(bool paused);
    event NativeWithdrawn(address indexed recipient, uint256 amount);
    event NusdWithdrawn(address indexed recipient, uint256 amount);

    constructor(
        address nusdToken,
        address initialAdmin,
        uint256 nativeDrip_,
        uint256 nusdDrip_,
        uint256 cooldownSeconds_,
        uint256 dailyNativeCap_,
        uint256 dailyNusdCap_
    ) TwoStepAdmin(initialAdmin) {
        if (block.chainid != EXPECTED_CHAIN_ID) revert WrongChain(EXPECTED_CHAIN_ID, block.chainid);
        if (nusdToken == address(0) || nusdToken.code.length == 0) revert InvalidNusd();

        nusd = nusdToken;
        _setDrip(nativeDrip_, nusdDrip_);
        _setCooldown(cooldownSeconds_);
        _setDailyCaps(dailyNativeCap_, dailyNusdCap_, nativeDrip_, nusdDrip_);
    }

    receive() external payable {}

    function claim() external nonReentrant {
        if (paused) revert FaucetPaused();
        if (tx.origin != msg.sender) revert ContractsNotAllowed();

        address account = msg.sender;
        (bool allowed, uint256 readyAt, uint256 nativeAmount, uint256 nusdAmount) = previewClaim(account);
        if (!allowed) {
            if (readyAt > block.timestamp) revert CooldownActive(readyAt);
            revert DailyCapExceeded();
        }
        if (address(this).balance < nativeAmount) {
            revert InsufficientNativeReserve(nativeAmount, address(this).balance);
        }
        uint256 nusdBalance = IERC20Minimal(nusd).balanceOf(address(this));
        if (nusdBalance < nusdAmount) revert InsufficientNusdReserve(nusdAmount, nusdBalance);

        _syncUtcDay();
        lastClaimAt[account] = block.timestamp;
        dailyNativeDispensed += nativeAmount;
        dailyNusdDispensed += nusdAmount;

        SafeTransferLib.safeTransferNative(account, nativeAmount);
        SafeTransferLib.safeTransfer(nusd, account, nusdAmount);
        emit Claimed(account, nativeAmount, nusdAmount, currentUtcDay);
    }

    function previewClaim(address account)
        public
        view
        returns (bool allowed, uint256 readyAt, uint256 nativeAmount, uint256 nusdAmount)
    {
        if (account == address(0)) revert InvalidRecipient();

        nativeAmount = nativeDrip;
        nusdAmount = nusdDrip;
        uint256 lastClaim = lastClaimAt[account];
        readyAt = lastClaim == 0 ? 0 : lastClaim + cooldownSeconds;
        if (readyAt > block.timestamp) return (false, readyAt, nativeAmount, nusdAmount);

        (uint256 nativeRemaining, uint256 nusdRemaining) = dailyRemaining();
        if (nativeAmount > nativeRemaining || nusdAmount > nusdRemaining) {
            return (false, readyAt, nativeAmount, nusdAmount);
        }
        return (true, readyAt, nativeAmount, nusdAmount);
    }

    function dailyRemaining() public view returns (uint256 nativeRemaining, uint256 nusdRemaining) {
        if (uint64(block.timestamp / 1 days) != currentUtcDay) {
            return (dailyNativeCap, dailyNusdCap);
        }
        nativeRemaining = dailyNativeCap - dailyNativeDispensed;
        nusdRemaining = dailyNusdCap - dailyNusdDispensed;
    }

    function setDrip(uint256 nativeDrip_, uint256 nusdDrip_) external onlyAdmin {
        _setDrip(nativeDrip_, nusdDrip_);
        if (dailyNativeCap < nativeDrip_ || dailyNusdCap < nusdDrip_) revert InvalidDailyCap();
    }

    function setCooldown(uint256 cooldownSeconds_) external onlyAdmin {
        _setCooldown(cooldownSeconds_);
    }

    function setDailyCaps(uint256 dailyNativeCap_, uint256 dailyNusdCap_) external onlyAdmin {
        _setDailyCaps(dailyNativeCap_, dailyNusdCap_, nativeDrip, nusdDrip);
    }

    function setPaused(bool paused_) external onlyAdmin {
        paused = paused_;
        emit PauseUpdated(paused_);
    }

    function withdrawNative(address recipient, uint256 amount) external onlyAdmin nonReentrant {
        if (recipient == address(0)) revert InvalidRecipient();
        SafeTransferLib.safeTransferNative(recipient, amount);
        emit NativeWithdrawn(recipient, amount);
    }

    function withdrawNusd(address recipient, uint256 amount) external onlyAdmin nonReentrant {
        if (recipient == address(0)) revert InvalidRecipient();
        SafeTransferLib.safeTransfer(nusd, recipient, amount);
        emit NusdWithdrawn(recipient, amount);
    }

    function _syncUtcDay() private {
        uint64 day = uint64(block.timestamp / 1 days);
        if (day == currentUtcDay) return;
        currentUtcDay = day;
        dailyNativeDispensed = 0;
        dailyNusdDispensed = 0;
    }

    function _setDrip(uint256 nativeDrip_, uint256 nusdDrip_) private {
        if (nativeDrip_ == 0 || nusdDrip_ == 0) revert InvalidDrip();
        nativeDrip = nativeDrip_;
        nusdDrip = nusdDrip_;
        emit DripUpdated(nativeDrip_, nusdDrip_);
    }

    function _setCooldown(uint256 cooldownSeconds_) private {
        if (cooldownSeconds_ < MIN_COOLDOWN || cooldownSeconds_ > MAX_COOLDOWN) revert InvalidCooldown();
        cooldownSeconds = cooldownSeconds_;
        emit CooldownUpdated(cooldownSeconds_);
    }

    function _setDailyCaps(uint256 dailyNativeCap_, uint256 dailyNusdCap_, uint256 nativeDrip_, uint256 nusdDrip_)
        private
    {
        if (dailyNativeCap_ < nativeDrip_ || dailyNusdCap_ < nusdDrip_) revert InvalidDailyCap();
        dailyNativeCap = dailyNativeCap_;
        dailyNusdCap = dailyNusdCap_;
        emit DailyCapsUpdated(dailyNativeCap_, dailyNusdCap_);
    }
}
