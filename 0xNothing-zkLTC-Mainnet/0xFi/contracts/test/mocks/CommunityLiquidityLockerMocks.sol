// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { CommunityLiquidityLocker } from "../../src/locking/CommunityLiquidityLocker.sol";
import { MockERC20 } from "./TokenMocks.sol";

/// @dev Minimal stand-in for IZeroXFiFactory.isPair; the locker only ever calls that one method.
contract MockLpFactory {
    mapping(address => bool) public isPair;

    function setPair(address token, bool value) external {
        isPair[token] = value;
    }
}

contract MissingPairFactory { }

contract ShortPairFactory {
    fallback() external {
        assembly ("memory-safe") {
            mstore(0, 0)
            return(1, 31)
        }
    }
}

contract LongPairFactory {
    fallback() external {
        assembly ("memory-safe") {
            mstore(0, 0)
            mstore(0x20, 0)
            return(0, 64)
        }
    }
}

contract NonCanonicalPairFactory {
    fallback() external {
        assembly ("memory-safe") {
            mstore(0, 2)
            return(0, 32)
        }
    }
}

/// @dev Returns true from transferFrom without moving any balance, to exercise the
/// received-delta ZeroReceived guard.
contract MockNoopToken {
    function balanceOf(address) external pure returns (uint256) {
        return 0;
    }

    function transferFrom(address, address, uint256) external pure returns (bool) {
        return true;
    }
}

/// @dev LP token whose transfer() reenters the locker mid-withdrawal.
contract ReentrantLpToken is MockERC20 {
    CommunityLiquidityLocker public locker;
    uint256 public reentryLockId;
    bool public armed;

    constructor() MockERC20("Reentrant LP", "RLP") { }

    function arm(CommunityLiquidityLocker locker_, uint256 lockId) external {
        locker = locker_;
        reentryLockId = lockId;
        armed = true;
    }

    function transfer(address to, uint256 value) public override returns (bool) {
        if (armed) {
            armed = false;
            locker.withdraw(reentryLockId);
        }
        return super.transfer(to, value);
    }
}
