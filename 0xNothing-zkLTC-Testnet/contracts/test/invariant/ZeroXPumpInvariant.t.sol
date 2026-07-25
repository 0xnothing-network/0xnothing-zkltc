// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {InvariantBase} from "../InvariantBase.sol";
import {NUSD} from "../../src/nusd/NUSD.sol";
import {ZeroXPump} from "../../src/pump/ZeroXPump.sol";
import {PumpToken} from "../../src/pump/PumpToken.sol";
import {GraduationRouter} from "../../src/graduation/GraduationRouter.sol";
import {PermanentLiquidityLocker} from "../../src/graduation/PermanentLiquidityLocker.sol";

contract PumpHandler {
    NUSD public immutable nusd;
    ZeroXPump public immutable pump;
    address public immutable token;

    constructor(NUSD nusd_, ZeroXPump pump_, address token_) {
        nusd = nusd_;
        pump = pump_;
        token = token_;
        nusd_.approve(address(pump_), type(uint256).max);
        PumpToken(token_).approve(address(pump_), type(uint256).max);
    }

    function buy(uint256 seed) external {
        if (pump.status(token) != uint8(ZeroXPump.Lifecycle.TRADING)) return;
        uint256 amount = 1e12 + (seed % (500 ether));
        uint256 balance = nusd.balanceOf(address(this));
        if (amount > balance) amount = balance;
        if (amount == 0) return;
        try pump.buy(token, amount, 0, type(uint256).max) {} catch {}
    }

    function sell(uint256 seed) external {
        uint8 lifecycle = pump.status(token);
        if (lifecycle != uint8(ZeroXPump.Lifecycle.TRADING) && lifecycle != uint8(ZeroXPump.Lifecycle.READY)) return;
        uint256 balance = PumpToken(token).balanceOf(address(this));
        if (balance == 0) return;
        uint256 amount = 1 + (seed % balance);
        try pump.sell(token, amount, 0, type(uint256).max) {} catch {}
    }
}

contract ZeroXPumpInvariantTest is InvariantBase {
    uint256 private constant SUPPLY = 1_000_000_000 ether;
    uint256 private constant VIRTUAL_NUSD = 1_500 ether;
    uint256 private constant MARKET_CAP_TARGET = 6_000 ether;
    uint256 private constant RESERVE_THRESHOLD = 1_500 ether;

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
        nusd.approve(address(pump), 1 ether);
        bytes32 commitment = keccak256("invariant-market");
        pump.reserveMarket(commitment);
        token = pump.createMarket("Invariant Token", "INV", "ipfs://metadata", "ipfs://image", commitment);

        PumpHandler handler = new PumpHandler(nusd, pump, token);
        nusd.mint(address(handler), 100_000 ether);
        targetContract(address(handler));
    }

    function invariantNusdBalanceIsFullyAccounted() public view {
        assertEq(
            nusd.balanceOf(address(pump)),
            pump.totalRealNusdReserves() + pump.accruedProtocolFeesNusd(),
            "pump NUSD accounting"
        );
    }

    function invariantCurveInventoryMatchesMarket() public view {
        (, uint256 tokenReserve,,,,,,,,,) = pump.markets(token);
        assertEq(PumpToken(token).balanceOf(address(pump)), tokenReserve, "token inventory");
    }

    function invariantCurveProductDoesNotDecrease() public view {
        (,,, uint256 virtualToken, uint256 virtualNusd,,,,,,) = pump.markets(token);
        assertGe(virtualToken * virtualNusd, SUPPLY * VIRTUAL_NUSD, "curve product");
    }

    function invariantGraduationThresholdCannotBeCrossed() public view {
        (,, uint256 realReserve,,,,,,,,) = pump.markets(token);
        assertLe(realReserve, RESERVE_THRESHOLD, "reserve threshold cap");
    }
}
