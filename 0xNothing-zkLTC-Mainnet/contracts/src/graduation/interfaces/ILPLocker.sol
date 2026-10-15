// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface ILPLocker {
    function onLiquidityLocked(address token, address lpToken, uint256 lpAmount, bytes32 pairId, address pool) external;
}
