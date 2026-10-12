// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {TestBase, Vm} from "../TestBase.sol";
import {TwoStepAdmin} from "../../src/common/TwoStepAdmin.sol";
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

    function testDustSellCannotReopenReadyMarket() public {
        address token = _createMarket();
        vm.prank(TRADER);
        (uint256 bought,) = pump.buy(token, 50_000 ether, 0, block.timestamp + 1);
        assertEq(pump.readyAt(token), block.timestamp, "ready timestamp");
        vm.prank(TRADER);
        PumpToken(token).approve(address(pump), bought);

        vm.expectRevert(ZeroXPump.MarketNotTrading.selector);
        vm.prank(TRADER);
        pump.sell(token, 1, 0, block.timestamp + 1);

        vm.expectRevert(ZeroXPump.MarketNotTrading.selector);
        pump.quoteSell(token, 1);

        vm.expectRevert(ZeroXPump.MarketNotTrading.selector);
        vm.prank(TRADER);
        pump.buy(token, 1 ether, 0, block.timestamp + 1);

        uint256 almostOpen = pump.readyAt(token) + pump.readyExitDelay() - 1;
        vm.warp(almostOpen);
        vm.expectRevert(ZeroXPump.MarketNotTrading.selector);
        vm.prank(TRADER);
        pump.sell(token, 1, 0, almostOpen + 1);
        assertEq(pump.status(token), uint8(ZeroXPump.Lifecycle.READY), "still ready");
    }

    function testReadyExitDelaySellReopensCurveAndCanReachReadyAgain() public {
        address token = _createMarket();
        vm.prank(TRADER);
        (uint256 bought,) = pump.buy(token, 50_000 ether, 0, block.timestamp + 1);
        assertEq(pump.status(token), uint8(ZeroXPump.Lifecycle.READY), "ready status");
        uint256 exitOpen = pump.readyAt(token) + pump.readyExitDelay();
        vm.warp(exitOpen);

        uint256 sellAmount = bought / 10;
        vm.prank(TRADER);
        PumpToken(token).approve(address(pump), sellAmount);
        vm.prank(TRADER);
        pump.sell(token, sellAmount, 0, exitOpen + 1);
        assertEq(pump.readyAt(token), 0, "ready timestamp cleared");

        assertEq(pump.status(token), uint8(ZeroXPump.Lifecycle.TRADING), "curve reopened");
        (,, uint256 reserveAfterSell,,,,,,,,) = pump.markets(token);
        assertLe(reserveAfterSell, RESERVE_THRESHOLD - 1, "reserve below threshold");
        assertEq(
            nusd.balanceOf(address(pump)),
            pump.totalRealNusdReserves() + pump.accruedProtocolFeesNusd(),
            "accounting after reopen"
        );

        vm.expectRevert(ZeroXPump.MarketNotReady.selector);
        pump.graduate(token, address(adapter), 1, exitOpen + 1);

        vm.prank(TRADER);
        pump.buy(token, 50_000 ether, 0, exitOpen + 1);
        assertEq(pump.status(token), uint8(ZeroXPump.Lifecycle.READY), "ready again");
        assertEq(pump.readyAt(token), exitOpen, "ready clock restarted");
    }

    function testOnlyAdminCanGraduateWhileTradingIsPaused() public {
        address token = _createMarket();
        vm.prank(TRADER);
        pump.buy(token, 50_000 ether, 0, block.timestamp + 1);
        uint256 graduationDeadline = block.timestamp + DELAY + 1 days;
        _enableAdapter();
        assertGe(block.timestamp, pump.readyAt(token) + pump.permissionlessGraduationDelay(), "public window open");

        pump.setPaused(true);
        vm.prank(TRADER);
        vm.expectRevert(ZeroXPump.ContractPaused.selector);
        pump.graduate(token, address(adapter), 1, graduationDeadline);

        pump.graduate(token, address(adapter), 1, graduationDeadline);
        assertEq(pump.status(token), uint8(ZeroXPump.Lifecycle.GRADUATED), "graduated");
    }

    function testAnyoneCanGraduateAfterPermissionlessDelay() public {
        _enableAdapter();
        address token = _createMarket();
        vm.prank(TRADER);
        pump.buy(token, 50_000 ether, 0, block.timestamp + 1);
        uint256 readyTime = pump.readyAt(token);
        uint256 graduationDeadline = block.timestamp + 1 days;

        vm.warp(readyTime + pump.permissionlessGraduationDelay() - 1);
        vm.prank(TRADER);
        vm.expectRevert(TwoStepAdmin.Unauthorized.selector);
        pump.graduate(token, address(adapter), 1, graduationDeadline);

        vm.warp(readyTime + pump.permissionlessGraduationDelay());
        vm.prank(TRADER);
        pump.graduate(token, address(adapter), 1, graduationDeadline);
        assertEq(pump.status(token), uint8(ZeroXPump.Lifecycle.GRADUATED), "graduated by anyone");

        vm.prank(TRADER);
        vm.expectRevert(ZeroXPump.MarketNotReady.selector);
        pump.graduate(token, address(adapter), 1, graduationDeadline);
        vm.expectRevert(ZeroXPump.MarketNotReady.selector);
        pump.graduate(token, address(adapter), 1, graduationDeadline);
    }

    function testAdminCanGraduateImmediatelyAndPublicCannotUseUnlistedAdapter() public {
        _enableAdapter();
        address token = _createMarket();
        vm.prank(TRADER);
        pump.buy(token, 50_000 ether, 0, block.timestamp + 1);

        uint256 publicOpen = pump.readyAt(token) + pump.permissionlessGraduationDelay();
        vm.warp(publicOpen);
        MockGraduationAdapter rogue = new MockGraduationAdapter();
        vm.prank(TRADER);
        vm.expectRevert(GraduationRouter.AdapterNotAllowed.selector);
        pump.graduate(token, address(rogue), 1, publicOpen + 1);

        address second = _createMarket();
        vm.prank(TRADER);
        pump.buy(second, 50_000 ether, 0, publicOpen + 1);
        pump.graduate(second, address(adapter), 1, publicOpen + 1);
        assertEq(pump.status(second), uint8(ZeroXPump.Lifecycle.GRADUATED), "admin graduates without delay");
    }

    function testGraduationDelayConfiguration() public {
        vm.prank(TRADER);
        vm.expectRevert(TwoStepAdmin.Unauthorized.selector);
        pump.setGraduationDelays(0, 1 days);

        vm.expectRevert(ZeroXPump.InvalidConfiguration.selector);
        pump.setGraduationDelays(1 days + 1, 7 days);
        vm.expectRevert(ZeroXPump.InvalidConfiguration.selector);
        pump.setGraduationDelays(0, 1 days - 1);
        vm.expectRevert(ZeroXPump.InvalidConfiguration.selector);
        pump.setGraduationDelays(0, 30 days + 1);

        pump.setGraduationDelays(0, 1 days);
        assertEq(pump.permissionlessGraduationDelay(), 0, "public graduation immediate");
        assertEq(pump.readyExitDelay(), 1 days, "exit delay");
    }

    function testPauseAllowsSellsButBlocksReserveCreateAndBuy() public {
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

        vm.expectRevert(ZeroXPump.ContractPaused.selector);
        vm.prank(TRADER);
        pump.buy(token, 1 ether, 0, block.timestamp + 1);

        vm.expectRevert(ZeroXPump.ContractPaused.selector);
        vm.prank(CREATOR);
        pump.reserveMarket(keccak256("paused-reserve"));

        uint256 nusdBefore = nusd.balanceOf(TRADER);
        vm.prank(TRADER);
        uint256 received = pump.sell(token, bought, 0, block.timestamp + 1);
        assertGt(received, 0, "paused exit");
        assertEq(nusd.balanceOf(TRADER), nusdBefore + received, "exit paid");
        assertEq(
            nusd.balanceOf(address(pump)),
            pump.totalRealNusdReserves() + pump.accruedProtocolFeesNusd(),
            "accounting after paused exit"
        );
    }

    function testLaunchProtectionIsOffByDefault() public {
        assertEq(pump.launchProtectionWindow(), 0, "window off");
        address token = _createMarket();
        (,, uint256 userAmount,,) = pump.quoteBuy(token, 1_000 ether);
        assertEq(userAmount, 1_000 ether, "uncapped at launch");
    }

    function testLaunchProtectionCapsEarlyBuysThenExpires() public {
        pump.setLaunchProtection(60, 10 ether);
        address token = _createMarket();

        (uint256 quotedOut,, uint256 quotedUser,,) = pump.quoteBuy(token, 1_000 ether);
        assertEq(quotedUser, 10 ether, "quote capped");
        uint256 balanceBefore = nusd.balanceOf(TRADER);
        vm.prank(TRADER);
        (uint256 tokenOut, uint256 spent) = pump.buy(token, 1_000 ether, quotedOut, block.timestamp + 1);
        assertEq(spent, 10 ether, "spend capped");
        assertEq(tokenOut, quotedOut, "quote matches capped execution");
        assertEq(balanceBefore - nusd.balanceOf(TRADER), 10 ether, "only cap pulled");

        (,,,,,, uint64 createdAt,,,,) = pump.markets(token);
        vm.warp(uint256(createdAt) + 59);
        (,, quotedUser,,) = pump.quoteBuy(token, 1_000 ether);
        assertEq(quotedUser, 10 ether, "still capped at last protected second");

        vm.warp(uint256(createdAt) + 60);
        (,, quotedUser,,) = pump.quoteBuy(token, 1_000 ether);
        assertEq(quotedUser, 1_000 ether, "cap expired");
    }

    function testLaunchProtectionConfiguration() public {
        vm.prank(TRADER);
        vm.expectRevert(TwoStepAdmin.Unauthorized.selector);
        pump.setLaunchProtection(60, 1 ether);

        vm.expectRevert(ZeroXPump.InvalidConfiguration.selector);
        pump.setLaunchProtection(1 hours + 1, 1 ether);
        vm.expectRevert(ZeroXPump.InvalidConfiguration.selector);
        pump.setLaunchProtection(60, 0);

        pump.setLaunchProtection(1 hours, 5 ether);
        assertEq(pump.launchMaxBuyNusd(), 5 ether, "cap set");
        pump.setLaunchProtection(0, 5 ether);
        assertEq(pump.launchProtectionWindow(), 0, "window disabled");
        assertEq(pump.launchMaxBuyNusd(), 0, "cap cleared");
    }

    function testTradeAndCreateEventsKeepTheirAbiEncoding() public {
        vm.recordLogs();
        bytes32 commitment = keccak256("event-encoding");
        vm.startPrank(CREATOR);
        pump.reserveMarket(commitment);
        address token = pump.createMarket("Nothing Meme", "MEME", "ipfs://meta", "ipfs://img", commitment);
        vm.stopPrank();
        vm.prank(TRADER);
        (uint256 tokenOut,) = pump.buy(token, 10 ether, 0, block.timestamp + 1);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        Vm.Log memory created = _findLog(
            logs,
            keccak256(
                "TokenCreated(address,address,bytes32,string,string,string,string,uint256,uint256,uint256,uint256,uint256,uint256,uint256)"
            )
        );
        assertEq(created.topics[1], bytes32(uint256(uint160(token))), "created token topic");
        assertEq(created.topics[2], bytes32(uint256(uint160(CREATOR))), "creator topic");
        assertEq(created.topics[3], commitment, "content hash topic");
        ZeroXPump.CreationLog memory creation = abi.decode(bytes.concat(bytes32(uint256(32)), created.data), (ZeroXPump.CreationLog));
        assertEq(keccak256(bytes(creation.name)), keccak256("Nothing Meme"), "name");
        assertEq(keccak256(bytes(creation.imageURI)), keccak256("ipfs://img"), "image");
        assertEq(creation.totalSupply, SUPPLY, "supply");
        assertEq(creation.graduationReserveThresholdNusd, RESERVE_THRESHOLD, "reserve threshold");
        assertEq(creation.creationFeeNusd, 1 ether, "creation fee");
        assertEq(keccak256(created.data), keccak256(_expectedCreationData()), "creation data");

        Vm.Log memory traded = _findLog(
            logs,
            keccak256(
                "TokenTraded(address,address,bool,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256)"
            )
        );
        assertEq(traded.topics[1], bytes32(uint256(uint160(token))), "traded token topic");
        assertEq(traded.topics[2], bytes32(uint256(uint160(TRADER))), "trader topic");
        assertEq(traded.topics[3], bytes32(uint256(1)), "isBuy topic");
        assertEq(traded.data.length, 11 * 32, "static trade data");
        ZeroXPump.TradeLog memory trade = abi.decode(traded.data, (ZeroXPump.TradeLog));
        assertEq(trade.tokenAmount, tokenOut, "trade amount");
        assertEq(trade.userNusdAmount, 10 ether, "user amount");
        assertEq(trade.feeNusd, 0.01 ether, "fee");
        assertEq(trade.circulatingSupplyAfter, tokenOut, "circulating");
        assertEq(trade.spotPriceNusdWad, pump.spotPriceNusdWad(token), "spot");
        assertEq(trade.curveProgressBps, pump.curveProgressBps(token), "progress");
    }

    function testViewsReportRegistryAndAccounting() public {
        address first = _createMarket();
        address second = _createMarket();
        assertEq(pump.createFee(), 1 ether, "create fee");
        assertEq(pump.tradeFeeBps(), 10, "trade fee");
        assertEq(pump.nusd(), address(nusd), "nusd");
        assertEq(pump.totalMarkets(), 2, "market count");
        address[] memory all = pump.getAllTokens();
        assertEq(all.length, 2, "all tokens");
        assertEq(all[1], second, "registry order");
        assertEq(pump.getTokensByCreator(CREATOR)[0], first, "creator registry");
        assertEq(pump.getTokensByCreator(TRADER).length, 0, "empty creator");
        assertEq(pump.accountedNusdBalance(), nusd.balanceOf(address(pump)), "accounted balance");
        assertEq(pump.curveProgressBps(first), 0, "no progress");
    }

    function testTradeGuardsRejectBadInputs() public {
        address token = _createMarket();
        uint256 expired = block.timestamp - 1;

        vm.startPrank(TRADER);
        vm.expectRevert(ZeroXPump.DeadlineExpired.selector);
        pump.buy(token, 1 ether, 0, expired);
        vm.expectRevert(ZeroXPump.InvalidAmount.selector);
        pump.buy(token, 0, 0, block.timestamp);
        vm.expectRevert(ZeroXPump.SlippageExceeded.selector);
        pump.buy(token, 1 ether, type(uint256).max, block.timestamp);
        vm.expectRevert(ZeroXPump.MarketNotFound.selector);
        pump.buy(address(0x1234), 1 ether, 0, block.timestamp);

        (uint256 bought,) = pump.buy(token, 1 ether, 0, block.timestamp);
        PumpToken(token).approve(address(pump), bought);
        vm.expectRevert(ZeroXPump.DeadlineExpired.selector);
        pump.sell(token, bought, 0, expired);
        vm.expectRevert(ZeroXPump.InvalidAmount.selector);
        pump.sell(token, 0, 0, block.timestamp);
        vm.expectRevert(ZeroXPump.SlippageExceeded.selector);
        pump.sell(token, bought, type(uint256).max, block.timestamp);
        vm.stopPrank();

        (uint256 tokenOut,,,,) = pump.quoteBuy(token, 0);
        assertEq(tokenOut, 0, "zero quote");
        (uint256 curveOut,,) = pump.quoteSell(token, 0);
        assertEq(curveOut, 0, "zero sell quote");
    }

    function testGraduateGuardsRejectBadInputs() public {
        address token = _createMarket();
        vm.expectRevert(ZeroXPump.MarketNotReady.selector);
        pump.graduate(token, address(adapter), 1, block.timestamp);
        vm.expectRevert(ZeroXPump.DeadlineExpired.selector);
        pump.graduate(token, address(adapter), 1, block.timestamp - 1);

        vm.prank(TRADER);
        pump.buy(token, 50_000 ether, 0, block.timestamp);
        vm.expectRevert(ZeroXPump.InvalidAmount.selector);
        pump.graduate(token, address(0), 1, block.timestamp);
        vm.expectRevert(ZeroXPump.InvalidAmount.selector);
        pump.graduate(token, address(adapter), 0, block.timestamp);
        assertEq(pump.curveProgressBps(token), 10_000, "full progress");
    }

    function testGraduatedMarketReportsFullProgressAndRejectsTrades() public {
        _enableAdapter();
        address token = _createMarket();
        vm.prank(TRADER);
        (uint256 bought,) = pump.buy(token, 50_000 ether, 0, type(uint256).max);
        pump.graduate(token, address(adapter), 1, type(uint256).max);
        assertEq(pump.curveProgressBps(token), 10_000, "graduated progress");

        vm.startPrank(TRADER);
        PumpToken(token).approve(address(pump), bought);
        vm.expectRevert(ZeroXPump.MarketNotTrading.selector);
        pump.sell(token, 1, 0, type(uint256).max);
        vm.expectRevert(ZeroXPump.MarketNotTrading.selector);
        pump.buy(token, 1 ether, 0, type(uint256).max);
        vm.stopPrank();
    }

    function testProtocolFeeWithdrawalGuards() public {
        _createMarket();
        vm.prank(TRADER);
        vm.expectRevert(TwoStepAdmin.Unauthorized.selector);
        pump.withdrawProtocolFees(TRADER, 1);
        vm.expectRevert(ZeroXPump.InsufficientProtocolFees.selector);
        pump.withdrawProtocolFees(address(0), 1);
        vm.expectRevert(ZeroXPump.InsufficientProtocolFees.selector);
        pump.withdrawProtocolFees(address(this), 0);
        vm.expectRevert(ZeroXPump.InsufficientProtocolFees.selector);
        pump.withdrawProtocolFees(address(this), 1 ether + 1);
        vm.prank(TRADER);
        vm.expectRevert(TwoStepAdmin.Unauthorized.selector);
        pump.setPaused(true);
    }

    function testCreateRejectsInvalidMetadata() public {
        bytes32 commitment = keccak256("metadata");
        vm.startPrank(CREATOR);
        pump.reserveMarket(commitment);
        vm.expectRevert(ZeroXPump.InvalidCommitment.selector);
        pump.reserveMarket(bytes32(0));
        vm.expectRevert(ZeroXPump.InvalidMetadata.selector);
        pump.createMarket("", "SYM", "ipfs://meta", "ipfs://img", commitment);
        vm.expectRevert(ZeroXPump.InvalidMetadata.selector);
        pump.createMarket("Name", "", "ipfs://meta", "ipfs://img", commitment);
        vm.expectRevert(ZeroXPump.InvalidMetadata.selector);
        pump.createMarket("Name", "SYMBOL_LONGER_THAN_16", "ipfs://meta", "ipfs://img", commitment);
        vm.expectRevert(ZeroXPump.InvalidMetadata.selector);
        pump.createMarket("Name", "SYM", "https://meta", "ipfs://img", commitment);
        vm.expectRevert(ZeroXPump.InvalidMetadata.selector);
        pump.createMarket("Name", "SYM", "ipfs://meta", "ipfs:/", commitment);
        pump.createMarket("Name", "SYM", "ipfs://meta", "ipfs://img", commitment);
        vm.stopPrank();
    }

    function _expectedCreationData() internal pure returns (bytes memory) {
        return abi.encode(
            "Nothing Meme",
            "MEME",
            "ipfs://meta",
            "ipfs://img",
            SUPPLY,
            SUPPLY,
            VIRTUAL_NUSD,
            SUPPLY,
            MARKET_CAP_TARGET,
            RESERVE_THRESHOLD,
            1 ether
        );
    }

    function _findLog(Vm.Log[] memory logs, bytes32 topic0) internal view returns (Vm.Log memory) {
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics.length > 0 && logs[i].topics[0] == topic0 && logs[i].emitter == address(pump)) {
                return logs[i];
            }
        }
        revert("log not found");
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
