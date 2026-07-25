// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {TestBase} from "../TestBase.sol";
import {NUSD} from "../../src/nusd/NUSD.sol";
import {ZeroXPump} from "../../src/pump/ZeroXPump.sol";
import {PumpToken} from "../../src/pump/PumpToken.sol";
import {GraduationRouter} from "../../src/graduation/GraduationRouter.sol";
import {PermanentLiquidityLocker} from "../../src/graduation/PermanentLiquidityLocker.sol";

contract ZeroXPumpFuzzTest is TestBase {
    uint256 private constant SUPPLY = 1_000_000_000 ether;
    uint256 private constant VIRTUAL_NUSD = 1_500 ether;
    uint256 private constant MARKET_CAP_TARGET = 6_000 ether;
    uint256 private constant RESERVE_THRESHOLD = 1_500 ether;
    address private constant TRADER = address(0xA11CE);

    NUSD private nusd;
    ZeroXPump private pump;
    address private token;

    function setUp() public {
        nusd = new NUSD(address(this));
        nusd.bindVault(address(this));
        PermanentLiquidityLocker locker = new PermanentLiquidityLocker(address(this));
        GraduationRouter router = new GraduationRouter(address(this), 1 hours, address(locker));
        pump = new ZeroXPump(
            address(nusd), address(nusd), address(router), address(this), SUPPLY, VIRTUAL_NUSD, MARKET_CAP_TARGET
        );
        router.bindPump(address(pump));
        locker.bindRouter(address(router));

        nusd.mint(address(this), 1 ether);
        nusd.approve(address(pump), type(uint256).max);
        bytes32 commitment = keccak256("fuzz-market");
        pump.reserveMarket(commitment);
        token = pump.createMarket("Fuzz Token", "FUZZ", "ipfs://metadata", "ipfs://image", commitment);

        nusd.mint(TRADER, 200_000 ether);
        vm.prank(TRADER);
        nusd.approve(address(pump), type(uint256).max);
    }

    function testFuzzBuyAccountingAndInvariant(uint256 rawNusdIn) public {
        uint256 maxNusdIn = bound(rawNusdIn, 1e12, 100_000 ether);
        (uint256 quotedOut, uint256 curveAmount, uint256 userAmount, uint256 feeAmount,) =
            pump.quoteBuy(token, maxNusdIn);
        uint256 productBefore = _virtualProduct();

        vm.prank(TRADER);
        (uint256 tokenOut, uint256 actualUserAmount) = pump.buy(token, maxNusdIn, quotedOut, type(uint256).max);

        assertEq(tokenOut, quotedOut, "quote matches execution");
        assertEq(actualUserAmount, userAmount, "actual user amount");
        assertEq(curveAmount + feeAmount, userAmount, "buy split");
        assertEq(feeAmount, (userAmount * 10) / 10_000, "buy fee");
        assertLe(userAmount, maxNusdIn, "input cap");
        assertGe(_virtualProduct(), productBefore, "constant product cannot decrease");

        (,, uint256 realReserve,,,,, ZeroXPump.Lifecycle lifecycle,,,) = pump.markets(token);
        assertLe(realReserve, RESERVE_THRESHOLD, "reserve target cannot be crossed");
        if (lifecycle == ZeroXPump.Lifecycle.READY) {
            assertEq(realReserve, RESERVE_THRESHOLD, "ready only at exact reserve target");
            assertEq((pump.spotPriceNusdWad(token) * SUPPLY) / 1e18, MARKET_CAP_TARGET, "ready market cap");
        }
        assertEq(
            nusd.balanceOf(address(pump)),
            pump.totalRealNusdReserves() + pump.accruedProtocolFeesNusd(),
            "NUSD accounting"
        );
    }

    function testFuzzRoundTripCannotProfit(uint256 rawNusdIn) public {
        uint256 maxNusdIn = bound(rawNusdIn, 1e12, 1_000 ether);
        uint256 nusdBefore = nusd.balanceOf(TRADER);

        vm.prank(TRADER);
        (uint256 tokenOut, uint256 spent) = pump.buy(token, maxNusdIn, 0, type(uint256).max);
        vm.prank(TRADER);
        PumpToken(token).approve(address(pump), tokenOut);

        (uint256 grossSell, uint256 quotedNet, uint256 sellFee) = pump.quoteSell(token, tokenOut);
        vm.prank(TRADER);
        uint256 received = pump.sell(token, tokenOut, quotedNet, type(uint256).max);

        assertEq(received, quotedNet, "sell quote matches");
        assertEq(grossSell - sellFee, quotedNet, "sell split");
        assertEq(sellFee, (grossSell * 10) / 10_000, "sell fee");
        assertLe(nusd.balanceOf(TRADER), nusdBefore, "round trip cannot profit");
        assertLe(received, spent, "received cannot exceed spent");
        assertEq(PumpToken(token).balanceOf(TRADER), 0, "all tokens sold");
    }

    function testFuzzOversizedFinalBuyCapsExactly(uint256 rawFirstBuy) public {
        uint256 firstBuy = bound(rawFirstBuy, 1e12, 1_000 ether);
        vm.prank(TRADER);
        pump.buy(token, firstBuy, 0, type(uint256).max);

        vm.prank(TRADER);
        pump.buy(token, 100_000 ether, 0, type(uint256).max);

        (,, uint256 realReserve,,,,, ZeroXPump.Lifecycle lifecycle,,,) = pump.markets(token);
        assertEq(realReserve, RESERVE_THRESHOLD, "final reserve exact");
        assertEq(uint8(lifecycle), uint8(ZeroXPump.Lifecycle.READY), "market ready");
    }

    function _virtualProduct() internal view returns (uint256 product) {
        (,,, uint256 virtualToken, uint256 virtualNusd,,,,,,) = pump.markets(token);
        product = virtualToken * virtualNusd;
    }
}
