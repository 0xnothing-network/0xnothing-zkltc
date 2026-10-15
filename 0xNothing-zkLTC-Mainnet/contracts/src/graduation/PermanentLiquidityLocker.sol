// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ILPLocker} from "./interfaces/ILPLocker.sol";
import {IERC20Minimal} from "../common/SafeTransferLib.sol";

contract PermanentLiquidityLocker is ILPLocker {
    error UnauthorizedRouter();
    error InvalidLock();

    address public immutable binder;
    address public router;

    struct LockRecord {
        address lpToken;
        uint256 lpAmount;
        bytes32 pairId;
        address pool;
        uint64 lockedAt;
    }

    mapping(address => LockRecord) public locks;

    event LiquidityPermanentlyLocked(
        address indexed token, address indexed lpToken, bytes32 indexed pairId, address pool, uint256 lpAmount
    );

    event RouterBound(address indexed router);

    constructor(address initialBinder) {
        if (initialBinder == address(0)) revert UnauthorizedRouter();
        binder = initialBinder;
    }

    function bindRouter(address graduationRouter) external {
        if (msg.sender != binder || router != address(0)) revert UnauthorizedRouter();
        if (graduationRouter == address(0) || graduationRouter.code.length == 0) revert InvalidLock();
        router = graduationRouter;
        emit RouterBound(graduationRouter);
    }

    function onLiquidityLocked(address token, address lpToken, uint256 lpAmount, bytes32 pairId, address pool)
        external
    {
        if (msg.sender != router) revert UnauthorizedRouter();
        if (
            token == address(0) || lpToken == address(0) || lpAmount == 0
                || IERC20Minimal(lpToken).balanceOf(address(this)) < lpAmount
        ) revert InvalidLock();

        LockRecord storage record = locks[token];
        if (record.lpAmount != 0) revert InvalidLock();
        locks[token] = LockRecord(lpToken, lpAmount, pairId, pool, uint64(block.timestamp));
        emit LiquidityPermanentlyLocked(token, lpToken, pairId, pool, lpAmount);
    }
}
