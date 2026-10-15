// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { CommunityLiquidityLocker } from "../../src/locking/CommunityLiquidityLocker.sol";
import { TestBase } from "../helpers/TestBase.sol";
import {
    LongPairFactory,
    MissingPairFactory,
    MockLpFactory,
    MockNoopToken,
    NonCanonicalPairFactory,
    ReentrantLpToken,
    ShortPairFactory
} from "../mocks/CommunityLiquidityLockerMocks.sol";
import { MockERC20, MockFeeOnTransferToken } from "../mocks/TokenMocks.sol";

contract CommunityLiquidityLockerTest is TestBase {
    address private constant ALICE = address(0xA11CE);
    address private constant BOB = address(0xB0B);

    MockLpFactory private factory;
    CommunityLiquidityLocker private locker;
    MockERC20 private lpToken;

    function setUp() public {
        vm.warp(1_000_000);
        factory = new MockLpFactory();
        locker = new CommunityLiquidityLocker(address(factory));
        lpToken = new MockERC20("LP Token", "0xFI-LP");
        factory.setPair(address(lpToken), true);
    }

    function testConstructorRejectsNonContractFactory() public {
        vm.expectRevert(CommunityLiquidityLocker.InvalidFactory.selector);
        new CommunityLiquidityLocker(ALICE);
    }

    function testConstructorRejectsInvalidFactoryInterface() public {
        address[4] memory invalidFactories = [
            address(new MissingPairFactory()),
            address(new ShortPairFactory()),
            address(new LongPairFactory()),
            address(new NonCanonicalPairFactory())
        ];

        for (uint256 i; i < invalidFactories.length; ++i) {
            vm.expectRevert(CommunityLiquidityLocker.InvalidFactory.selector);
            new CommunityLiquidityLocker(invalidFactories[i]);
        }
    }

    function testLockPermanentRecordsEvidenceAndCannotBeWithdrawn() public {
        _fundAndApprove(ALICE, lpToken, 1000 ether);
        vm.prank(ALICE);
        uint256 id = locker.lockPermanent(address(lpToken), 1000 ether);

        CommunityLiquidityLocker.Lock memory lock = locker.getLock(id);
        assertEq(lock.owner, ALICE, "owner recorded");
        assertEq(lock.lpToken, address(lpToken), "lp token recorded");
        assertEq(lock.amount, 1000 ether, "amount recorded");
        assertTrue(lock.permanent, "flagged permanent");
        assertFalse(lock.withdrawn, "not withdrawn");
        assertEq(locker.activeLockedByToken(address(lpToken)), 1000 ether, "active total");

        vm.warp(block.timestamp + 100 days);
        vm.expectRevert(CommunityLiquidityLocker.PermanentLock.selector);
        vm.prank(ALICE);
        locker.withdraw(id);
    }

    function testLockUntilWithdrawsExactlyAtBoundaryNotBefore() public {
        _fundAndApprove(ALICE, lpToken, 500 ether);
        uint64 unlockAt = uint64(block.timestamp + 30 days);
        vm.prank(ALICE);
        uint256 id = locker.lockUntil(address(lpToken), 500 ether, unlockAt);

        vm.warp(unlockAt - 1);
        vm.expectRevert(CommunityLiquidityLocker.LockNotExpired.selector);
        vm.prank(ALICE);
        locker.withdraw(id);

        vm.warp(unlockAt);
        vm.prank(ALICE);
        locker.withdraw(id);

        assertEq(lpToken.balanceOf(ALICE), 500 ether, "LP returned at boundary");
        assertEq(locker.activeLockedByToken(address(lpToken)), 0, "active total cleared");
        CommunityLiquidityLocker.Lock memory lock = locker.getLock(id);
        assertTrue(lock.withdrawn, "marked withdrawn");
    }

    function testWithdrawRejectsWrongOwnerAndDoubleWithdrawal() public {
        _fundAndApprove(ALICE, lpToken, 200 ether);
        uint64 unlockAt = uint64(block.timestamp + 1 days);
        vm.prank(ALICE);
        uint256 id = locker.lockUntil(address(lpToken), 200 ether, unlockAt);

        vm.warp(unlockAt);
        vm.expectRevert(CommunityLiquidityLocker.NotLockOwner.selector);
        vm.prank(BOB);
        locker.withdraw(id);

        vm.prank(ALICE);
        locker.withdraw(id);

        vm.expectRevert(CommunityLiquidityLocker.AlreadyWithdrawn.selector);
        vm.prank(ALICE);
        locker.withdraw(id);
    }

    function testLockRejectsZeroAmountPastUnlockAndUnrecognizedPair() public {
        _fundAndApprove(ALICE, lpToken, 10 ether);
        vm.expectRevert(CommunityLiquidityLocker.ZeroAmount.selector);
        vm.prank(ALICE);
        locker.lockPermanent(address(lpToken), 0);

        vm.expectRevert(CommunityLiquidityLocker.InvalidUnlockTime.selector);
        vm.prank(ALICE);
        locker.lockUntil(address(lpToken), 10 ether, uint64(block.timestamp));

        MockERC20 stranger = new MockERC20("Not a pair", "NOPE");
        _fundAndApprove(ALICE, stranger, 10 ether);
        vm.expectRevert(abi.encodeWithSelector(CommunityLiquidityLocker.UnrecognizedPair.selector, address(stranger)));
        vm.prank(ALICE);
        locker.lockPermanent(address(stranger), 10 ether);
    }

    function testUnknownLockLookupAndWithdrawRevert() public {
        vm.expectRevert(CommunityLiquidityLocker.UnknownLock.selector);
        locker.getLock(0);

        vm.expectRevert(CommunityLiquidityLocker.UnknownLock.selector);
        locker.withdraw(0);
    }

    function testMultipleIndependentRecordsAndOwnerEnumeration() public {
        _fundAndApprove(ALICE, lpToken, 300 ether);
        _fundAndApprove(BOB, lpToken, 300 ether);

        vm.prank(ALICE);
        uint256 idA1 = locker.lockPermanent(address(lpToken), 100 ether);
        vm.prank(BOB);
        uint256 idB1 = locker.lockUntil(address(lpToken), 150 ether, uint64(block.timestamp + 1 days));
        vm.prank(ALICE);
        uint256 idA2 = locker.lockPermanent(address(lpToken), 50 ether);

        assertEq(locker.lockCount(), 3, "three total records");
        assertEq(locker.ownerLockCount(ALICE), 2, "alice has two records");
        assertEq(locker.ownerLockCount(BOB), 1, "bob has one record");

        uint256[] memory aliceIds = locker.ownerLockIds(ALICE);
        assertEq(aliceIds.length, 2, "alice enumeration length");
        assertEq(aliceIds[0], idA1, "first alice id preserved");
        assertEq(aliceIds[1], idA2, "second alice id preserved");

        uint256[] memory bobIds = locker.ownerLockIds(BOB);
        assertEq(bobIds.length, 1, "bob enumeration length");
        assertEq(bobIds[0], idB1, "bob id preserved");

        assertEq(locker.activeLockedByToken(address(lpToken)), 300 ether, "aggregate reflects all active locks");

        vm.warp(block.timestamp + 1 days);
        vm.prank(BOB);
        locker.withdraw(idB1);
        assertEq(locker.activeLockedByToken(address(lpToken)), 150 ether, "aggregate drops after withdrawal");

        // Earlier records remain intact and enumerable after a later withdrawal.
        CommunityLiquidityLocker.Lock memory recordA1 = locker.getLock(idA1);
        assertFalse(recordA1.withdrawn, "unrelated record untouched");
        assertEq(locker.lockCount(), 3, "history is never deleted");
    }

    function testFeeOnTransferLpTokenAccountsReceivedDeltaNotRequestedAmount() public {
        MockFeeOnTransferToken feeLp = new MockFeeOnTransferToken();
        factory.setPair(address(feeLp), true);
        feeLp.mint(ALICE, 1000 ether);
        vm.prank(ALICE);
        feeLp.approve(address(locker), type(uint256).max);

        vm.prank(ALICE);
        uint256 id = locker.lockPermanent(address(feeLp), 1000 ether);

        // MockFeeOnTransferToken charges 1% to address(1) on transfers of >= 100 units.
        uint256 expectedReceived = 1000 ether - (1000 ether / 100);
        CommunityLiquidityLocker.Lock memory lock = locker.getLock(id);
        assertEq(lock.amount, expectedReceived, "locked amount is the post-fee delta");
        assertEq(locker.activeLockedByToken(address(feeLp)), expectedReceived, "aggregate uses delta too");
    }

    function testZeroReceivedTokenIsRejected() public {
        MockNoopToken noop = new MockNoopToken();
        factory.setPair(address(noop), true);
        vm.expectRevert(CommunityLiquidityLocker.ZeroReceived.selector);
        vm.prank(ALICE);
        locker.lockPermanent(address(noop), 1 ether);
    }

    function testWithdrawalIsProtectedFromReentrancy() public {
        ReentrantLpToken evilLp = new ReentrantLpToken();
        factory.setPair(address(evilLp), true);
        evilLp.mint(ALICE, 100 ether);
        vm.prank(ALICE);
        evilLp.approve(address(locker), type(uint256).max);

        vm.prank(ALICE);
        uint256 id = locker.lockUntil(address(evilLp), 100 ether, uint64(block.timestamp + 1 days));
        vm.warp(block.timestamp + 1 days);

        evilLp.arm(locker, id);
        vm.expectRevert();
        vm.prank(ALICE);
        locker.withdraw(id);
    }

    function testFuzzLockUntilBoundary(uint64 offset) public {
        uint64 delay = uint64(bound(offset, 1, 3650 days));
        _fundAndApprove(ALICE, lpToken, 1 ether);
        uint64 unlockAt = uint64(block.timestamp) + delay;
        vm.prank(ALICE);
        uint256 id = locker.lockUntil(address(lpToken), 1 ether, unlockAt);

        vm.warp(unlockAt);
        vm.prank(ALICE);
        locker.withdraw(id);
        assertEq(lpToken.balanceOf(ALICE), 1 ether, "fuzzed boundary withdrawal succeeds");
    }

    function _fundAndApprove(address account, MockERC20 token, uint256 amount) private {
        token.mint(account, amount);
        vm.prank(account);
        token.approve(address(locker), type(uint256).max);
    }
}
