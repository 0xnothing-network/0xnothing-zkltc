// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {TestBase} from "../TestBase.sol";
import {NUSD} from "../../src/nusd/NUSD.sol";
import {ZeroXPump} from "../../src/pump/ZeroXPump.sol";
import {PumpToken} from "../../src/pump/PumpToken.sol";
import {GraduationRouter} from "../../src/graduation/GraduationRouter.sol";
import {PermanentLiquidityLocker} from "../../src/graduation/PermanentLiquidityLocker.sol";
import {MockGraduationAdapter, MockLPToken} from "../mocks/MockGraduationAdapter.sol";

contract ZeroXPumpTest is TestBase {
    uint256 private constant SUPPLY = 1_000_000_000 ether;
    uint256 private constant VIRTUAL_NUSD = 1_500 ether;
    uint256 private constant MARKET_CAP_TARGET = 6_000 ether;
    uint256 private constant RESERVE_THRESHOLD = 1_500 ether;
    uint256 private constant DELAY = 1 hours;

    NUSD private nusd;
    PermanentLiquidityLocker private locker;
    GraduationRouter private router;
    ZeroXPump private pump;
    MockGraduationAdapter private adapter;
    uint256 private reservationNonce;

    address private constant CREATOR = address(0xC0FFEE);
    address private constant TRADER = address(0xA11CE);

    function setUp() public {
        vm.warp(1_000_000);
        nusd = new NUSD(address(this));
        nusd.bindVault(address(this));
        locker = new PermanentLiquidityLocker(address(this));
        router = new GraduationRouter(address(this), DELAY, address(locker));
        pump = new ZeroXPump(
            address(nusd), address(nusd), address(router), address(this), SUPPLY, VIRTUAL_NUSD, MARKET_CAP_TARGET
        );
        router.bindPump(address(pump));
        locker.bindRouter(address(router));
        adapter = new MockGraduationAdapter();

        nusd.mint(CREATOR, 100 ether);
        nusd.mint(TRADER, 100_000 ether);
        vm.prank(CREATOR);
        nusd.approve(address(pump), type(uint256).max);
        vm.prank(TRADER);
        nusd.approve(address(pump), type(uint256).max);
    }

    function testCreateChargesOneNusdAndMintsFullSupplyToPump() public {
        uint256 creatorBefore = nusd.balanceOf(CREATOR);
        address token = _createMarket();

        assertEq(creatorBefore - nusd.balanceOf(CREATOR), 1 ether, "creation fee");
        assertEq(pump.accruedProtocolFeesNusd(), 1 ether, "fee accounting");
        assertEq(PumpToken(token).balanceOf(address(pump)), SUPPLY, "curve inventory");
        assertEq(PumpToken(token).totalSupply(), SUPPLY, "fixed supply");
        assertEq(pump.status(token), uint8(ZeroXPump.Lifecycle.TRADING), "trading status");
    }

    function testReserveChargesFeeBeforeIpfsUpload() public {
        bytes32 commitment = keccak256("prepaid-upload");
        uint256 balanceBefore = nusd.balanceOf(CREATOR);

        vm.prank(CREATOR);
        pump.reserveMarket(commitment);

        assertEq(balanceBefore - nusd.balanceOf(CREATOR), 1 ether, "prepaid fee");
        assertEq(pump.accruedProtocolFeesNusd(), 1 ether, "fee accrued at reserve");
        assertTrue(pump.creationReservations(CREATOR, commitment), "reserved status");
    }

    function testCreatedTokenLookupRecoversLostReceiptAndBlocksSecondReserve() public {
        bytes32 contentHash = keccak256("lost-receipt");
        vm.startPrank(CREATOR);
        pump.reserveMarket(contentHash);
        address token = pump.createMarket("Recoverable", "RCVR", "ipfs://metadata", "ipfs://image", contentHash);
        vm.stopPrank();

        assertEq(pump.createdTokenByContentHash(CREATOR, contentHash), token, "recover created token");
        assertFalse(pump.creationReservations(CREATOR, contentHash), "reservation consumed");

        uint256 balanceAfterCreation = nusd.balanceOf(CREATOR);
        uint256 feesAfterCreation = pump.accruedProtocolFeesNusd();
        vm.expectRevert();
        vm.prank(CREATOR);
        pump.reserveMarket(contentHash);
        assertEq(nusd.balanceOf(CREATOR), balanceAfterCreation, "no second fee transfer");
        assertEq(pump.accruedProtocolFeesNusd(), feesAfterCreation, "no second fee accrual");
    }

    function testReservationOwnershipDuplicateAndReplayProtection() public {
        bytes32 commitment = keccak256("unique-content");
        vm.prank(CREATOR);
        pump.reserveMarket(commitment);

        vm.expectRevert();
        vm.prank(CREATOR);
        pump.reserveMarket(commitment);

        vm.expectRevert();
        vm.prank(TRADER);
        pump.createMarket("Wrong Owner", "WRONG", "ipfs://metadata", "ipfs://image", commitment);

        vm.prank(TRADER);
        pump.reserveMarket(commitment);
        assertTrue(pump.creationReservations(CREATOR, commitment), "creator reservation intact");
        assertTrue(pump.creationReservations(TRADER, commitment), "copy is sender scoped");

        vm.prank(CREATOR);
        pump.createMarket("Reserved", "RSV", "ipfs://metadata", "ipfs://image", commitment);
        assertFalse(pump.creationReservations(CREATOR, commitment), "reservation consumed");

        vm.expectRevert();
        vm.prank(CREATOR);
        pump.createMarket("Replay", "RPL", "ipfs://metadata", "ipfs://image", commitment);
    }

    function testMissingCommitmentsCannotCreate() public {
        vm.expectRevert();
        vm.prank(CREATOR);
        pump.createMarket("Missing", "MISS", "ipfs://metadata", "ipfs://image", bytes32(0));

        vm.expectRevert();
        vm.prank(CREATOR);
        pump.createMarket("Unknown", "UNKNOWN", "ipfs://metadata", "ipfs://image", keccak256("never-reserved"));
    }

    function testBuyAndSellUseTenBasisPointFee() public {
        address token = _createMarket();
        (uint256 quotedTokenOut, uint256 curveAmount, uint256 userAmount, uint256 buyFee,) =
            pump.quoteBuy(token, 10 ether);
        assertEq(userAmount, 10 ether, "gross buy");
        assertEq(buyFee, 0.01 ether, "10 bps buy fee");
        assertEq(curveAmount, 9.99 ether, "curve buy amount");

        vm.prank(TRADER);
        (uint256 tokenOut,) = pump.buy(token, 10 ether, quotedTokenOut, block.timestamp + 1);
        assertEq(tokenOut, quotedTokenOut, "buy quote");

        uint256 sellAmount = tokenOut / 2;
        vm.prank(TRADER);
        PumpToken(token).approve(address(pump), sellAmount);
        (uint256 grossSell, uint256 netSell, uint256 sellFee) = pump.quoteSell(token, sellAmount);
        assertEq(sellFee, (grossSell * 10) / 10_000, "10 bps sell fee");

        vm.prank(TRADER);
        uint256 received = pump.sell(token, sellAmount, netSell, block.timestamp + 1);
        assertEq(received, netSell, "sell quote");
        assertEq(pump.accruedProtocolFeesNusd(), 1 ether + buyFee + sellFee, "all fees");
    }

    function testThresholdMovesToReadyWithoutCallingDex() public {
        address token = _createMarket();
        uint256 initialMarketCap = (pump.spotPriceNusdWad(token) * SUPPLY) / 1e18;
        assertEq(pump.graduationThresholdNusd(), MARKET_CAP_TARGET, "market-cap target");
        assertEq(pump.graduationReserveThresholdNusd(), RESERVE_THRESHOLD, "derived reserve target");
        assertEq(initialMarketCap, VIRTUAL_NUSD, "initial market cap");
        assertFalse(router.enabled(), "test deployment starts disabled");

        vm.prank(TRADER);
        pump.buy(token, 50_000 ether, 0, block.timestamp + 1);

        assertEq(pump.status(token), uint8(ZeroXPump.Lifecycle.READY), "ready status");
        (,, uint256 realReserve,,,,,,,,) = pump.markets(token);
        assertEq(realReserve, RESERVE_THRESHOLD, "reserve target capped exactly");
        uint256 readyMarketCap = (pump.spotPriceNusdWad(token) * SUPPLY) / 1e18;
        assertEq(readyMarketCap, MARKET_CAP_TARGET, "ready at exact market cap");

        vm.expectRevert();
        pump.graduate(token, address(adapter), 1, block.timestamp + 1);
        assertEq(pump.status(token), uint8(ZeroXPump.Lifecycle.READY), "failure keeps READY");
    }

    function testReadySellReopensCurveAndCanReachReadyAgain() public {
        address token = _createMarket();
        vm.prank(TRADER);
        (uint256 bought,) = pump.buy(token, 50_000 ether, 0, block.timestamp + 1);
        assertEq(pump.status(token), uint8(ZeroXPump.Lifecycle.READY), "ready status");

        uint256 sellAmount = bought / 10;
        vm.prank(TRADER);
        PumpToken(token).approve(address(pump), sellAmount);
        vm.prank(TRADER);
        pump.sell(token, sellAmount, 0, block.timestamp + 1);

        assertEq(pump.status(token), uint8(ZeroXPump.Lifecycle.TRADING), "curve reopened");
        (,, uint256 reserveAfterSell,,,,,,,,) = pump.markets(token);
        assertLe(reserveAfterSell, RESERVE_THRESHOLD - 1, "reserve below threshold");
        assertEq(
            nusd.balanceOf(address(pump)),
            pump.totalRealNusdReserves() + pump.accruedProtocolFeesNusd(),
            "accounting after reopen"
        );

        vm.expectRevert();
        pump.graduate(token, address(adapter), 1, block.timestamp + 1);

        vm.prank(TRADER);
        pump.buy(token, 50_000 ether, 0, block.timestamp + 1);
        assertEq(pump.status(token), uint8(ZeroXPump.Lifecycle.READY), "ready again");
    }

    function testOnlyAdminCanGraduateWhileTradingIsPaused() public {
        address token = _createMarket();
        vm.prank(TRADER);
        pump.buy(token, 50_000 ether, 0, block.timestamp + 1);
        uint256 graduationDeadline = block.timestamp + DELAY + 1 days;
        _enableAdapter();

        vm.prank(TRADER);
        vm.expectRevert();
        pump.graduate(token, address(adapter), 1, graduationDeadline);

        pump.setPaused(true);
        pump.graduate(token, address(adapter), 1, graduationDeadline);
        assertEq(pump.status(token), uint8(ZeroXPump.Lifecycle.GRADUATED), "graduated");
    }

    function testPauseBlocksCreateBuyAndSell() public {
        address token = _createMarket();
        vm.prank(TRADER);
        (uint256 bought,) = pump.buy(token, 10 ether, 0, block.timestamp + 1);
        vm.prank(TRADER);
        PumpToken(token).approve(address(pump), bought);
        bytes32 pausedCommitment = keccak256("paused-create");
        vm.prank(CREATOR);
        pump.reserveMarket(pausedCommitment);
        pump.setPaused(true);

        vm.expectRevert();
        vm.prank(CREATOR);
        pump.createMarket("Paused", "PAUSE", "ipfs://metadata", "ipfs://image", pausedCommitment);

        vm.expectRevert();
        vm.prank(TRADER);
        pump.buy(token, 1 ether, 0, block.timestamp + 1);

        vm.expectRevert();
        vm.prank(TRADER);
        pump.sell(token, bought, 0, block.timestamp + 1);
    }

    function testTimelockedGraduationLocksLpAndPreservesTerminalPrice() public {
        address token = _createMarket();
        vm.prank(TRADER);
        pump.buy(token, 50_000 ether, 0, block.timestamp + 1);
        uint256 terminalPrice = pump.spotPriceNusdWad(token);
        uint256 graduationDeadline = block.timestamp + DELAY + 1 days;

        _enableAdapter();
        pump.graduate(token, address(adapter), 1, graduationDeadline);
        assertEq(pump.status(token), uint8(ZeroXPump.Lifecycle.GRADUATED), "graduated");

        (address lpToken, uint256 lpAmount, bytes32 pairId, address pool,) = locker.locks(token);
        assertEq(lpToken, address(adapter.lpToken()), "locked LP token");
        assertGt(lpAmount, 0, "locked LP amount");
        assertEq(MockLPToken(lpToken).balanceOf(address(locker)), lpAmount, "locker custody");
        assertEq(pool, address(adapter), "pool");
        assertTrue(pairId != bytes32(0), "pair id");

        (,,,,,,,,,, address recordedPool) = pump.markets(token);
        assertEq(recordedPool, address(adapter), "recorded pool");

        uint256 nusdLiquidity = RESERVE_THRESHOLD;
        uint256 tokenLiquidity = PumpToken(token).balanceOf(address(adapter));
        uint256 dexPrice = (nusdLiquidity * 1e18) / tokenLiquidity;
        uint256 difference = dexPrice > terminalPrice ? dexPrice - terminalPrice : terminalPrice - dexPrice;
        assertLe(difference, 1, "graduation price continuity");
    }

    function testProtocolFeeWithdrawalCannotTouchCurveReserves() public {
        address token = _createMarket();
        vm.prank(TRADER);
        pump.buy(token, 10 ether, 0, block.timestamp + 1);
        uint256 reservesBefore = pump.totalRealNusdReserves();
        uint256 fees = pump.accruedProtocolFeesNusd();

        pump.withdrawProtocolFees(address(this), fees);
        assertEq(pump.totalRealNusdReserves(), reservesBefore, "reserves unchanged");
        assertEq(nusd.balanceOf(address(pump)), reservesBefore, "only reserves remain");
    }

    function testAdapterRevertRollsBackBurnAndMarketState() public {
        address token = _createMarket();
        vm.prank(TRADER);
        pump.buy(token, 50_000 ether, 0, block.timestamp + 1);
        uint256 supplyBefore = PumpToken(token).totalSupply();
        uint256 graduationDeadline = block.timestamp + DELAY + 1 days;
        _enableAdapter();
        adapter.setShouldRevert(true);

        vm.expectRevert();
        pump.graduate(token, address(adapter), 1, graduationDeadline);
        assertEq(PumpToken(token).totalSupply(), supplyBefore, "burn rolled back");
        assertEq(pump.status(token), uint8(ZeroXPump.Lifecycle.READY), "state rolled back");
    }

    function testAdapterCannotReportStaleLpAsNewLiquidity() public {
        address token = _createMarket();
        vm.prank(TRADER);
        pump.buy(token, 50_000 ether, 0, block.timestamp + 1);
        uint256 graduationDeadline = block.timestamp + DELAY + 1 days;
        _enableAdapter();

        adapter.lpToken().mint(address(router), 123 ether);
        adapter.setSkipLpMint(true);
        vm.expectRevert();
        pump.graduate(token, address(adapter), 1, graduationDeadline);

        assertEq(pump.status(token), uint8(ZeroXPump.Lifecycle.READY), "state rolled back");
        assertEq(adapter.lpToken().balanceOf(address(router)), 123 ether, "stale LP unchanged");
    }

    function testPreExistingLpDustDoesNotBlockGraduation() public {
        address token = _createMarket();
        vm.prank(TRADER);
        pump.buy(token, 50_000 ether, 0, block.timestamp + 1);
        uint256 graduationDeadline = block.timestamp + DELAY + 1 days;
        _enableAdapter();

        adapter.lpToken().mint(address(router), 123);
        pump.graduate(token, address(adapter), 1, graduationDeadline);

        assertEq(pump.status(token), uint8(ZeroXPump.Lifecycle.GRADUATED), "graduated");
        assertEq(adapter.lpToken().balanceOf(address(router)), 123, "dust preserved");
    }

    function _createMarket() internal returns (address token) {
        bytes32 commitment = keccak256(abi.encode("test-market", ++reservationNonce));
        vm.startPrank(CREATOR);
        pump.reserveMarket(commitment);
        token = pump.createMarket("Nothing Meme", "MEME", "ipfs://bafybeimetadata", "ipfs://bafybeiimage", commitment);
        vm.stopPrank();
    }

    function _enableAdapter() internal {
        router.scheduleAdapter(address(adapter));
        router.scheduleEnable();
        vm.warp(block.timestamp + DELAY);
        router.activateAdapter(address(adapter));
        router.enableRouter();
    }
}
