// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20Minimal, SafeTransferLib} from "../common/SafeTransferLib.sol";
import {ReentrancyGuard} from "../common/ReentrancyGuard.sol";
import {TwoStepAdmin} from "../common/TwoStepAdmin.sol";
import {IGraduationAdapter} from "./interfaces/IGraduationAdapter.sol";
import {ILPLocker} from "./interfaces/ILPLocker.sol";

contract GraduationRouter is TwoStepAdmin, ReentrancyGuard {
    error InvalidConfiguration();
    error RouterDisabled();
    error AdapterNotAllowed();
    error PumpAlreadyBound();
    error OnlyPump();
    error TimelockNotReady();
    error InvalidGraduationResult();
    error AssetTransferMismatch();

    uint256 public immutable minimumDelay;
    address public immutable lpRecipient;
    address public pump;
    bool public enabled;
    uint256 public enableAt;

    mapping(address => bool) public isAdapterAllowed;
    mapping(address => uint256) public adapterActivationTime;

    event PumpBound(address indexed pump);
    event AdapterScheduled(address indexed adapter, uint256 activationTime);
    event AdapterActivated(address indexed adapter);
    event AdapterDisabled(address indexed adapter);
    event EnableScheduled(uint256 activationTime);
    event RouterEnabled();
    event RouterDisabledByAdmin();
    event GraduationExecuted(
        address indexed token,
        address indexed adapter,
        address indexed dex,
        bytes32 pairId,
        address pool,
        address lpToken,
        uint256 lpAmount,
        address lpRecipient
    );

    constructor(address initialAdmin, uint256 delaySeconds, address permanentLpRecipient) TwoStepAdmin(initialAdmin) {
        if (delaySeconds < 1 hours || permanentLpRecipient == address(0) || permanentLpRecipient.code.length == 0) {
            revert InvalidConfiguration();
        }
        minimumDelay = delaySeconds;
        lpRecipient = permanentLpRecipient;
    }

    function bindPump(address pumpAddress) external onlyAdmin {
        if (pump != address(0)) revert PumpAlreadyBound();
        if (pumpAddress == address(0) || pumpAddress.code.length == 0) revert InvalidConfiguration();
        pump = pumpAddress;
        emit PumpBound(pumpAddress);
    }

    function scheduleAdapter(address adapter) external onlyAdmin {
        if (adapter == address(0) || adapter.code.length == 0) revert InvalidConfiguration();
        uint256 activationTime = block.timestamp + minimumDelay;
        adapterActivationTime[adapter] = activationTime;
        emit AdapterScheduled(adapter, activationTime);
    }

    function activateAdapter(address adapter) external {
        uint256 activationTime = adapterActivationTime[adapter];
        if (activationTime == 0 || block.timestamp < activationTime) revert TimelockNotReady();
        delete adapterActivationTime[adapter];
        isAdapterAllowed[adapter] = true;
        emit AdapterActivated(adapter);
    }

    function disableAdapter(address adapter) external onlyAdmin {
        delete adapterActivationTime[adapter];
        isAdapterAllowed[adapter] = false;
        emit AdapterDisabled(adapter);
    }

    function scheduleEnable() external onlyAdmin {
        enableAt = block.timestamp + minimumDelay;
        emit EnableScheduled(enableAt);
    }

    function enableRouter() external {
        if (enableAt == 0 || block.timestamp < enableAt) revert TimelockNotReady();
        enableAt = 0;
        enabled = true;
        emit RouterEnabled();
    }

    function disableRouter() external onlyAdmin {
        enabled = false;
        enableAt = 0;
        emit RouterDisabledByAdmin();
    }

    function executeGraduation(
        address adapter,
        address token,
        address nusd,
        uint256 tokenAmount,
        uint256 nusdAmount,
        uint256 minimumLp,
        uint256 deadline
    ) external nonReentrant returns (IGraduationAdapter.GraduationResult memory result) {
        if (msg.sender != pump) revert OnlyPump();
        if (!enabled) revert RouterDisabled();
        if (!isAdapterAllowed[adapter]) revert AdapterNotAllowed();
        if (
            token == address(0) || nusd == address(0) || tokenAmount == 0 || nusdAmount == 0 || minimumLp == 0
                || block.timestamp > deadline
        ) revert InvalidConfiguration();

        address expectedLpToken = IGraduationAdapter(adapter).lpTokenFor(token, nusd);
        if (expectedLpToken == address(0) || expectedLpToken.code.length == 0) {
            revert InvalidGraduationResult();
        }
        uint256 lpBalanceBefore = IERC20Minimal(expectedLpToken).balanceOf(address(this));

        uint256 tokenBalanceBefore = IERC20Minimal(token).balanceOf(address(this));
        uint256 nusdBalanceBefore = IERC20Minimal(nusd).balanceOf(address(this));
        SafeTransferLib.safeTransferFrom(token, msg.sender, address(this), tokenAmount);
        SafeTransferLib.safeTransferFrom(nusd, msg.sender, address(this), nusdAmount);
        if (
            IERC20Minimal(token).balanceOf(address(this)) != tokenBalanceBefore + tokenAmount
                || IERC20Minimal(nusd).balanceOf(address(this)) != nusdBalanceBefore + nusdAmount
        ) revert AssetTransferMismatch();

        SafeTransferLib.forceApprove(token, adapter, tokenAmount);
        SafeTransferLib.forceApprove(nusd, adapter, nusdAmount);
        result = IGraduationAdapter(adapter)
            .graduate(
                IGraduationAdapter.GraduationParams({
                token: token,
                nusd: nusd,
                tokenAmount: tokenAmount,
                nusdAmount: nusdAmount,
                minimumLp: minimumLp,
                deadline: deadline,
                lpRecipient: address(this)
            })
            );
        SafeTransferLib.forceApprove(token, adapter, 0);
        SafeTransferLib.forceApprove(nusd, adapter, 0);

        if (
            result.dex == address(0) || result.pool == address(0) || result.lpToken != expectedLpToken
                || result.lpAmount < minimumLp || IERC20Minimal(token).balanceOf(address(this)) != tokenBalanceBefore
                || IERC20Minimal(nusd).balanceOf(address(this)) != nusdBalanceBefore
                || IERC20Minimal(expectedLpToken).balanceOf(address(this)) != lpBalanceBefore + result.lpAmount
        ) revert InvalidGraduationResult();

        SafeTransferLib.safeTransfer(result.lpToken, lpRecipient, result.lpAmount);
        ILPLocker(lpRecipient).onLiquidityLocked(token, result.lpToken, result.lpAmount, result.pairId, result.pool);

        emit GraduationExecuted(
            token, adapter, result.dex, result.pairId, result.pool, result.lpToken, result.lpAmount, lpRecipient
        );
    }
}
