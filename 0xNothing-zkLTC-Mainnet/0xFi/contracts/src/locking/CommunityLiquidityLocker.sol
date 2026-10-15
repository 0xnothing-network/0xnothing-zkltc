// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import { IZeroXFiFactory } from "../interfaces/IZeroXFiFactory.sol";

/// @title CommunityLiquidityLocker
/// @notice Trust-minimised locker for community 0xFi LP tokens. Anyone can lock LP either
/// permanently or until a future timestamp, producing on-chain evidence that liquidity cannot
/// be pulled. The locker never grants any admin the ability to seize or redirect locked LP:
/// permanent locks are irreversible and finite locks return only to their original depositor.
contract CommunityLiquidityLocker is ReentrancyGuard {
    using SafeERC20 for IERC20;

    error InvalidFactory();
    error ZeroAmount();
    error ZeroReceived();
    error UnrecognizedPair(address lpToken);
    error InvalidUnlockTime();
    error UnknownLock();
    error NotLockOwner();
    error PermanentLock();
    error AlreadyWithdrawn();
    error LockNotExpired();

    struct Lock {
        address owner;
        address lpToken;
        uint256 amount;
        uint64 lockedAt;
        uint64 unlockAt;
        bool permanent;
        bool withdrawn;
    }

    IZeroXFiFactory public immutable factory;

    Lock[] private _locks;
    mapping(address => uint256[]) private _ownerLocks;

    /// @notice Total LP still locked per pair (permanent locks plus un-withdrawn finite locks).
    mapping(address => uint256) public activeLockedByToken;

    event LiquidityLocked(
        uint256 indexed id,
        address indexed owner,
        address indexed lpToken,
        uint256 amount,
        uint64 unlockAt,
        bool permanent
    );
    event LiquidityWithdrawn(uint256 indexed id, address indexed owner, address indexed lpToken, uint256 amount);

    constructor(address factory_) {
        if (factory_.code.length == 0) revert InvalidFactory();

        (bool success, bytes memory data) =
            factory_.staticcall(abi.encodeWithSelector(IZeroXFiFactory.isPair.selector, address(0)));
        if (!success || data.length != 32) revert InvalidFactory();

        uint256 encodedResult;
        assembly ("memory-safe") {
            encodedResult := mload(add(data, 0x20))
        }
        if (encodedResult > 1) revert InvalidFactory();

        factory = IZeroXFiFactory(factory_);
    }

    /// @notice Lock `amount` of `lpToken` forever. The LP can never be recovered.
    function lockPermanent(address lpToken, uint256 amount) external nonReentrant returns (uint256 id) {
        id = _lock(lpToken, amount, 0, true);
    }

    /// @notice Lock `amount` of `lpToken` until `unlockAt`, after which the depositor may withdraw.
    /// @param unlockAt Unix timestamp strictly greater than the current block time.
    function lockUntil(address lpToken, uint256 amount, uint64 unlockAt) external nonReentrant returns (uint256 id) {
        // forge-lint: disable-next-line(block-timestamp)
        if (unlockAt <= block.timestamp) revert InvalidUnlockTime();
        id = _lock(lpToken, amount, unlockAt, false);
    }

    /// @notice Withdraw an expired finite lock back to its original depositor.
    function withdraw(uint256 id) external nonReentrant {
        Lock storage lock = _lockAt(id);
        if (lock.owner != msg.sender) revert NotLockOwner();
        if (lock.permanent) revert PermanentLock();
        if (lock.withdrawn) revert AlreadyWithdrawn();
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp < lock.unlockAt) revert LockNotExpired();

        uint256 amount = lock.amount;
        address lpToken = lock.lpToken;
        lock.withdrawn = true;
        activeLockedByToken[lpToken] -= amount;

        IERC20(lpToken).safeTransfer(msg.sender, amount);
        emit LiquidityWithdrawn(id, msg.sender, lpToken, amount);
    }

    function lockCount() external view returns (uint256) {
        return _locks.length;
    }

    function getLock(uint256 id) external view returns (Lock memory) {
        return _lockAt(id);
    }

    function ownerLockIds(address owner) external view returns (uint256[] memory) {
        return _ownerLocks[owner];
    }

    function ownerLockCount(address owner) external view returns (uint256) {
        return _ownerLocks[owner].length;
    }

    function _lock(address lpToken, uint256 amount, uint64 unlockAt, bool permanent) private returns (uint256 id) {
        if (amount == 0) revert ZeroAmount();
        if (!factory.isPair(lpToken)) revert UnrecognizedPair(lpToken);

        IERC20 lp = IERC20(lpToken);
        uint256 balanceBefore = lp.balanceOf(address(this));
        lp.safeTransferFrom(msg.sender, address(this), amount);
        uint256 received = lp.balanceOf(address(this)) - balanceBefore;
        if (received == 0) revert ZeroReceived();

        id = _locks.length;
        _locks.push(
            Lock({
                owner: msg.sender,
                lpToken: lpToken,
                amount: received,
                // forge-lint: disable-next-line(unsafe-typecast)
                lockedAt: uint64(block.timestamp),
                unlockAt: unlockAt,
                permanent: permanent,
                withdrawn: false
            })
        );
        _ownerLocks[msg.sender].push(id);
        activeLockedByToken[lpToken] += received;

        emit LiquidityLocked(id, msg.sender, lpToken, received, unlockAt, permanent);
    }

    function _lockAt(uint256 id) private view returns (Lock storage) {
        if (id >= _locks.length) revert UnknownLock();
        return _locks[id];
    }
}
