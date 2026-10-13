// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {TestBase} from "../TestBase.sol";
import {MathX} from "../../src/common/MathX.sol";
import {SafeTransferLib} from "../../src/common/SafeTransferLib.sol";
import {TwoStepAdmin} from "../../src/common/TwoStepAdmin.sol";
import {GraduationRouter} from "../../src/graduation/GraduationRouter.sol";
import {PermanentLiquidityLocker} from "../../src/graduation/PermanentLiquidityLocker.sol";
import {IGraduationAdapter} from "../../src/graduation/interfaces/IGraduationAdapter.sol";
import {MockGraduationAdapter, MockLPToken} from "../mocks/MockGraduationAdapter.sol";

contract MisreportingAdapter is IGraduationAdapter {
    enum Mode {
        ZeroDex,
        WrongLpToken,
        KeepsNothing,
        OverreportsLp,
        NoLpToken
    }

    MockLPToken public immutable lpToken;
    Mode public mode;

    constructor() {
        lpToken = new MockLPToken();
    }

    function setMode(Mode value) external {
        mode = value;
    }

    function lpTokenFor(address, address) external view returns (address) {
        return mode == Mode.NoLpToken ? address(0) : address(lpToken);
    }

    function preparePool(address) external view returns (address) {
        return mode == Mode.NoLpToken ? address(0) : address(lpToken);
    }

    function quoteMinimumLp(address, address, uint256, uint256) external pure returns (uint256) {
        return 1;
    }

    function graduate(GraduationParams calldata params) external returns (GraduationResult memory result) {
        if (mode != Mode.KeepsNothing) {
            SafeTransferLib.safeTransferFrom(params.token, msg.sender, address(this), params.tokenAmount);
            SafeTransferLib.safeTransferFrom(params.nusd, msg.sender, address(this), params.nusdAmount);
        }
        lpToken.mint(params.lpRecipient, 100);
        result = GraduationResult({
            dex: mode == Mode.ZeroDex ? address(0) : address(this),
            pairId: bytes32(uint256(1)),
            pool: address(this),
            lpToken: mode == Mode.WrongLpToken ? address(0xDEAD) : address(lpToken),
            lpAmount: mode == Mode.OverreportsLp ? 101 : 100
        });
    }
}

contract GraduationRouterTest is TestBase {
    uint256 private constant DELAY = 1 hours;
    uint256 private constant ENABLED_AT = 1_000_000 + DELAY;
    address private constant OUTSIDER = address(0xBAD);

    PermanentLiquidityLocker private locker;
    GraduationRouter private router;
    MockGraduationAdapter private adapter;
    MockLPToken private token;
    MockLPToken private nusd;

    function setUp() public {
        vm.warp(1_000_000);
        locker = new PermanentLiquidityLocker(address(this));
        router = new GraduationRouter(address(this), DELAY, address(locker));
        locker.bindRouter(address(router));
        router.bindPump(address(this));
        adapter = new MockGraduationAdapter();
        token = new MockLPToken();
        nusd = new MockLPToken();
        token.mint(address(this), 1_000 ether);
        nusd.mint(address(this), 1_000 ether);
        token.approve(address(router), type(uint256).max);
        nusd.approve(address(router), type(uint256).max);
    }

    function testConstructorRejectsUnsafeConfiguration() public {
        vm.expectRevert(GraduationRouter.InvalidConfiguration.selector);
        new GraduationRouter(address(this), DELAY - 1, address(locker));
        vm.expectRevert(GraduationRouter.InvalidConfiguration.selector);
        new GraduationRouter(address(this), DELAY, address(0));
        vm.expectRevert(GraduationRouter.InvalidConfiguration.selector);
        new GraduationRouter(address(this), DELAY, OUTSIDER);
        assertEq(router.minimumDelay(), DELAY, "delay");
        assertEq(router.lpRecipient(), address(locker), "recipient");
        assertFalse(router.enabled(), "starts disabled");
    }

    function testPumpBindsOnceByAdminOnly() public {
        GraduationRouter fresh = new GraduationRouter(address(this), DELAY, address(locker));
        vm.prank(OUTSIDER);
        vm.expectRevert(TwoStepAdmin.Unauthorized.selector);
        fresh.bindPump(address(this));
        vm.expectRevert(GraduationRouter.InvalidConfiguration.selector);
        fresh.bindPump(OUTSIDER);
        fresh.bindPump(address(this));
        assertEq(fresh.pump(), address(this), "bound");
        vm.expectRevert(GraduationRouter.PumpAlreadyBound.selector);
        fresh.bindPump(address(adapter));
    }

    function testAdapterActivationIsTimelocked() public {
        vm.prank(OUTSIDER);
        vm.expectRevert(TwoStepAdmin.Unauthorized.selector);
        router.scheduleAdapter(address(adapter));
        vm.expectRevert(GraduationRouter.InvalidConfiguration.selector);
        router.scheduleAdapter(OUTSIDER);
        vm.expectRevert(GraduationRouter.TimelockNotReady.selector);
        router.activateAdapter(address(adapter));

        router.scheduleAdapter(address(adapter));
        uint256 activation = router.adapterActivationTime(address(adapter));
        assertEq(activation, 1_000_000 + DELAY, "activation time");
        vm.warp(activation - 1);
        vm.expectRevert(GraduationRouter.TimelockNotReady.selector);
        router.activateAdapter(address(adapter));

        vm.warp(activation);
        vm.prank(OUTSIDER);
        router.activateAdapter(address(adapter));
        assertTrue(router.isAdapterAllowed(address(adapter)), "allowed");
        assertEq(router.adapterActivationTime(address(adapter)), 0, "schedule consumed");

        vm.prank(OUTSIDER);
        vm.expectRevert(TwoStepAdmin.Unauthorized.selector);
        router.disableAdapter(address(adapter));
        router.disableAdapter(address(adapter));
        assertFalse(router.isAdapterAllowed(address(adapter)), "disabled");
    }

    function testDisableAdapterCancelsPendingSchedule() public {
        router.scheduleAdapter(address(adapter));
        router.disableAdapter(address(adapter));
        vm.warp(1_000_000 + DELAY);
        vm.expectRevert(GraduationRouter.TimelockNotReady.selector);
        router.activateAdapter(address(adapter));
    }

    function testRouterEnableIsTimelockedAndDisableCancels() public {
        vm.expectRevert(GraduationRouter.TimelockNotReady.selector);
        router.enableRouter();
        vm.prank(OUTSIDER);
        vm.expectRevert(TwoStepAdmin.Unauthorized.selector);
        router.scheduleEnable();

        router.scheduleEnable();
        vm.warp(1_000_000 + DELAY - 1);
        vm.expectRevert(GraduationRouter.TimelockNotReady.selector);
        router.enableRouter();

        router.disableRouter();
        assertEq(router.enableAt(), 0, "schedule cancelled");
        vm.warp(1_000_000 + DELAY);
        vm.expectRevert(GraduationRouter.TimelockNotReady.selector);
        router.enableRouter();

        router.scheduleEnable();
        vm.warp(1_000_000 + 2 * DELAY);
        router.enableRouter();
        assertTrue(router.enabled(), "enabled");
        vm.prank(OUTSIDER);
        vm.expectRevert(TwoStepAdmin.Unauthorized.selector);
        router.disableRouter();
    }

    function testExecuteGraduationGuards() public {
        vm.prank(OUTSIDER);
        vm.expectRevert(GraduationRouter.OnlyPump.selector);
        router.executeGraduation(address(adapter), address(token), address(nusd), 1, 1, 1, 1_000_000);

        vm.expectRevert(GraduationRouter.RouterDisabled.selector);
        router.executeGraduation(address(adapter), address(token), address(nusd), 1, 1, 1, 1_000_000);

        _enableWith(address(adapter));
        address unlisted = address(new MockGraduationAdapter());
        vm.expectRevert(GraduationRouter.AdapterNotAllowed.selector);
        router.executeGraduation(unlisted, address(token), address(nusd), 1, 1, 1, ENABLED_AT);

        uint256 deadline = ENABLED_AT;
        vm.expectRevert(GraduationRouter.InvalidConfiguration.selector);
        router.executeGraduation(address(adapter), address(0), address(nusd), 1, 1, 1, deadline);
        vm.expectRevert(GraduationRouter.InvalidConfiguration.selector);
        router.executeGraduation(address(adapter), address(token), address(nusd), 0, 1, 1, deadline);
        vm.expectRevert(GraduationRouter.InvalidConfiguration.selector);
        router.executeGraduation(address(adapter), address(token), address(nusd), 1, 0, 1, deadline);
        vm.expectRevert(GraduationRouter.InvalidConfiguration.selector);
        router.executeGraduation(address(adapter), address(token), address(nusd), 1, 1, 0, deadline);
        vm.expectRevert(GraduationRouter.InvalidConfiguration.selector);
        router.executeGraduation(address(adapter), address(token), address(nusd), 1, 1, 1, deadline - 1);
    }

    function testExecuteGraduationLocksLpPermanently() public {
        _enableWith(address(adapter));
        IGraduationAdapter.GraduationResult memory result = router.executeGraduation(
            address(adapter), address(token), address(nusd), 400 ether, 100 ether, 1, ENABLED_AT
        );

        uint256 expectedLp = MathX.sqrt(400 ether * 100 ether) - 1_000;
        assertEq(result.lpAmount, expectedLp, "lp amount");
        assertEq(adapter.lpToken().balanceOf(address(locker)), expectedLp, "locker custody");
        assertEq(adapter.lpToken().balanceOf(address(router)), 0, "router holds no LP");
        assertEq(token.balanceOf(address(router)), 0, "router holds no token");
        assertEq(nusd.balanceOf(address(router)), 0, "router holds no NUSD");
        assertEq(token.allowance(address(router), address(adapter)), 0, "token approval cleared");
        assertEq(nusd.allowance(address(router), address(adapter)), 0, "NUSD approval cleared");
        (address lockedLp, uint256 lockedAmount,,,) = locker.locks(address(token));
        assertEq(lockedLp, address(adapter.lpToken()), "lock token");
        assertEq(lockedAmount, expectedLp, "lock amount");

        vm.expectRevert(PermanentLiquidityLocker.InvalidLock.selector);
        router.executeGraduation(address(adapter), address(token), address(nusd), 1 ether, 1 ether, 1, ENABLED_AT);
    }

    function testRejectsMisreportedGraduationResults() public {
        MisreportingAdapter bad = new MisreportingAdapter();
        _enableWith(address(bad));
        MisreportingAdapter.Mode[5] memory modes = [
            MisreportingAdapter.Mode.ZeroDex,
            MisreportingAdapter.Mode.WrongLpToken,
            MisreportingAdapter.Mode.KeepsNothing,
            MisreportingAdapter.Mode.OverreportsLp,
            MisreportingAdapter.Mode.NoLpToken
        ];
        for (uint256 i; i < modes.length; ++i) {
            bad.setMode(modes[i]);
            vm.expectRevert(GraduationRouter.InvalidGraduationResult.selector);
            router.executeGraduation(address(bad), address(token), address(nusd), 1 ether, 1 ether, 1, ENABLED_AT);
        }
        assertEq(token.balanceOf(address(this)), 1_000 ether, "token rolled back");
        assertEq(nusd.balanceOf(address(this)), 1_000 ether, "NUSD rolled back");
    }

    function testMinimumLpIsEnforcedByAdapter() public {
        _enableWith(address(adapter));
        vm.expectRevert(bytes("MIN_LP"));
        router.executeGraduation(
            address(adapter), address(token), address(nusd), 10 ether, 10 ether, 10 ether + 1, ENABLED_AT
        );
    }

    function _enableWith(address target) private {
        router.scheduleAdapter(target);
        router.scheduleEnable();
        vm.warp(ENABLED_AT);
        router.activateAdapter(target);
        router.enableRouter();
    }
}

contract PermanentLiquidityLockerTest is TestBase {
    address private constant OUTSIDER = address(0xBAD);
    address private constant TOKEN = address(0x7015);

    PermanentLiquidityLocker private locker;
    MockLPToken private lpToken;

    function setUp() public {
        locker = new PermanentLiquidityLocker(address(this));
        locker.bindRouter(address(this));
        lpToken = new MockLPToken();
    }

    function testConstructorRejectsZeroBinder() public {
        vm.expectRevert(PermanentLiquidityLocker.UnauthorizedRouter.selector);
        new PermanentLiquidityLocker(address(0));
    }

    function testRouterBindsOnceByBinderOnly() public {
        PermanentLiquidityLocker fresh = new PermanentLiquidityLocker(address(this));
        vm.prank(OUTSIDER);
        vm.expectRevert(PermanentLiquidityLocker.UnauthorizedRouter.selector);
        fresh.bindRouter(address(this));
        vm.expectRevert(PermanentLiquidityLocker.InvalidLock.selector);
        fresh.bindRouter(address(0));
        vm.expectRevert(PermanentLiquidityLocker.InvalidLock.selector);
        fresh.bindRouter(OUTSIDER);

        fresh.bindRouter(address(this));
        assertEq(fresh.router(), address(this), "bound");
        vm.expectRevert(PermanentLiquidityLocker.UnauthorizedRouter.selector);
        fresh.bindRouter(address(lpToken));
    }

    function testRecordsLockOnceAndOnlyFromRouter() public {
        lpToken.mint(address(locker), 50);

        vm.prank(OUTSIDER);
        vm.expectRevert(PermanentLiquidityLocker.UnauthorizedRouter.selector);
        locker.onLiquidityLocked(TOKEN, address(lpToken), 50, bytes32(uint256(1)), address(0x9001));

        locker.onLiquidityLocked(TOKEN, address(lpToken), 50, bytes32(uint256(1)), address(0x9001));
        (address recordedLp, uint256 amount, bytes32 pairId, address pool, uint64 lockedAt) = locker.locks(TOKEN);
        assertEq(recordedLp, address(lpToken), "lp");
        assertEq(amount, 50, "amount");
        assertEq(pairId, bytes32(uint256(1)), "pair");
        assertEq(pool, address(0x9001), "pool");
        assertEq(uint256(lockedAt), block.timestamp, "timestamp");

        vm.expectRevert(PermanentLiquidityLocker.InvalidLock.selector);
        locker.onLiquidityLocked(TOKEN, address(lpToken), 50, bytes32(uint256(2)), address(0x9002));
    }

    function testRejectsInvalidOrUnbackedLocks() public {
        lpToken.mint(address(locker), 10);
        vm.expectRevert(PermanentLiquidityLocker.InvalidLock.selector);
        locker.onLiquidityLocked(address(0), address(lpToken), 10, bytes32(0), address(0));
        vm.expectRevert(PermanentLiquidityLocker.InvalidLock.selector);
        locker.onLiquidityLocked(TOKEN, address(0), 10, bytes32(0), address(0));
        vm.expectRevert(PermanentLiquidityLocker.InvalidLock.selector);
        locker.onLiquidityLocked(TOKEN, address(lpToken), 0, bytes32(0), address(0));
        vm.expectRevert(PermanentLiquidityLocker.InvalidLock.selector);
        locker.onLiquidityLocked(TOKEN, address(lpToken), 11, bytes32(0), address(0));
    }
}
