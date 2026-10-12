// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {InvariantBase} from "../InvariantBase.sol";
import {TestBase} from "../TestBase.sol";
import {NUSD} from "../../src/nusd/NUSD.sol";
import {ZeroXPump} from "../../src/pump/ZeroXPump.sol";
import {PumpToken} from "../../src/pump/PumpToken.sol";
import {GraduationRouter} from "../../src/graduation/GraduationRouter.sol";
import {PermanentLiquidityLocker} from "../../src/graduation/PermanentLiquidityLocker.sol";
import {MockGraduationAdapter, MockLPToken} from "../mocks/MockGraduationAdapter.sol";

contract PumpHandler is TestBase {
    NUSD public immutable nusd;
    ZeroXPump public immutable pump;
    MockGraduationAdapter public immutable adapter;
    MockLPToken public immutable lpToken;
    address public immutable locker;
    address[] public tokens;

    mapping(address => uint256) public graduationCount;
    mapping(address => uint256) public supplyAtGraduation;
    uint256 public lastLockerLpBalance;
    bool public lockerLpDecreased;

    constructor(
        NUSD nusd_,
        ZeroXPump pump_,
        MockGraduationAdapter adapter_,
        address locker_,
        address[] memory tokens_
    ) {
        nusd = nusd_;
        pump = pump_;
        adapter = adapter_;
        lpToken = adapter_.lpToken();
        locker = locker_;
        tokens = tokens_;
        nusd_.approve(address(pump_), type(uint256).max);
        for (uint256 i; i < tokens_.length; ++i) {
            PumpToken(tokens_[i]).approve(address(pump_), type(uint256).max);
        }
    }

    function tokenCount() external view returns (uint256) {
        return tokens.length;
    }

    function buy(uint256 tokenSeed, uint256 amountSeed) external {
        address token = _token(tokenSeed);
        uint256 amount = 1e12 + (amountSeed % (1_600 ether));
        uint256 balance = nusd.balanceOf(address(this));
        if (amount > balance) amount = balance;
        if (amount != 0) {
            try pump.buy(token, amount, 0, type(uint256).max) {} catch {}
        }
        _trackLocker();
    }

    function sell(uint256 tokenSeed, uint256 amountSeed) external {
        address token = _token(tokenSeed);
        uint256 balance = PumpToken(token).balanceOf(address(this));
        if (balance != 0) {
            try pump.sell(token, 1 + (amountSeed % balance), 0, type(uint256).max) {} catch {}
        }
        _trackLocker();
    }

    function dustSell(uint256 tokenSeed) external {
        address token = _token(tokenSeed);
        if (PumpToken(token).balanceOf(address(this)) != 0) {
            try pump.sell(token, 1, 0, type(uint256).max) {} catch {}
        }
        _trackLocker();
    }

    function graduate(uint256 tokenSeed) external {
        address token = _token(tokenSeed);
        try pump.graduate(token, address(adapter), 1, type(uint256).max) {
            ++graduationCount[token];
            supplyAtGraduation[token] = PumpToken(token).totalSupply();
        } catch {}
        _trackLocker();
    }

    function warp(uint256 secondsSeed) external {
        vm.warp(block.timestamp + (secondsSeed % 3 hours));
        _trackLocker();
    }

    function _token(uint256 seed) private view returns (address) {
        return tokens[seed % tokens.length];
    }

    function _trackLocker() private {
        uint256 balance = lpToken.balanceOf(locker);
        if (balance < lastLockerLpBalance) lockerLpDecreased = true;
        lastLockerLpBalance = balance;
    }
}

contract ZeroXPumpInvariantTest is InvariantBase {
    uint256 private constant SUPPLY = 1_000_000_000 ether;
    uint256 private constant VIRTUAL_NUSD = 1_500 ether;
    uint256 private constant MARKET_CAP_TARGET = 6_000 ether;
    uint256 private constant RESERVE_THRESHOLD = 1_500 ether;
    uint256 private constant MARKETS = 3;

    NUSD private nusd;
    ZeroXPump private pump;
    PermanentLiquidityLocker private locker;
    MockGraduationAdapter private adapter;
    PumpHandler private handler;
    address[] private tokens;

    function setUp() public {
        vm.warp(1_000_000);
        nusd = new NUSD(address(this));
        nusd.bindVault(address(this));
        locker = new PermanentLiquidityLocker(address(this));
        GraduationRouter router = new GraduationRouter(address(this), 1 hours, address(locker));
        pump = new ZeroXPump(
            address(nusd), address(nusd), address(router), address(this), SUPPLY, VIRTUAL_NUSD, MARKET_CAP_TARGET
        );
        router.bindPump(address(pump));
        locker.bindRouter(address(router));

        adapter = new MockGraduationAdapter();
        router.scheduleAdapter(address(adapter));
        router.scheduleEnable();
        vm.warp(1_000_000 + 1 hours);
        router.activateAdapter(address(adapter));
        router.enableRouter();
        pump.setGraduationDelays(1 hours, 1 days);

        nusd.mint(address(this), MARKETS * 1 ether);
        nusd.approve(address(pump), type(uint256).max);
        for (uint256 i; i < MARKETS; ++i) {
            bytes32 commitment = keccak256(abi.encode("invariant-market", i));
            pump.reserveMarket(commitment);
            tokens.push(pump.createMarket("Invariant Token", "INV", "ipfs://metadata", "ipfs://image", commitment));
        }

        handler = new PumpHandler(nusd, pump, adapter, address(locker), tokens);
        nusd.mint(address(handler), 100_000 ether);
        targetContract(address(handler));
    }

    function invariantNusdBalanceIsFullyAccounted() public view {
        uint256 summedReserves;
        for (uint256 i; i < tokens.length; ++i) {
            (,, uint256 realReserve,,,,,,,,) = pump.markets(tokens[i]);
            summedReserves += realReserve;
        }
        assertEq(summedReserves, pump.totalRealNusdReserves(), "sum of market reserves");
        assertEq(
            nusd.balanceOf(address(pump)),
            pump.totalRealNusdReserves() + pump.accruedProtocolFeesNusd(),
            "pump NUSD accounting"
        );
    }

    function invariantCurveInventoryMatchesMarket() public view {
        for (uint256 i; i < tokens.length; ++i) {
            (, uint256 tokenReserve,,,,,,,,,) = pump.markets(tokens[i]);
            assertEq(PumpToken(tokens[i]).balanceOf(address(pump)), tokenReserve, "token inventory");
        }
    }

    function invariantCurveProductDoesNotDecrease() public view {
        for (uint256 i; i < tokens.length; ++i) {
            (,,, uint256 virtualToken, uint256 virtualNusd,,,,,,) = pump.markets(tokens[i]);
            assertGe(virtualToken * virtualNusd, SUPPLY * VIRTUAL_NUSD, "curve product");
        }
    }

    function invariantGraduationThresholdCannotBeCrossed() public view {
        for (uint256 i; i < tokens.length; ++i) {
            (,, uint256 realReserve,,,,, ZeroXPump.Lifecycle lifecycle,,,) = pump.markets(tokens[i]);
            assertLe(realReserve, RESERVE_THRESHOLD, "reserve threshold cap");
            if (lifecycle == ZeroXPump.Lifecycle.READY) {
                assertEq(realReserve, RESERVE_THRESHOLD, "READY markets keep the full reserve");
            }
        }
    }

    function invariantGraduatesAtMostOnce() public view {
        for (uint256 i; i < tokens.length; ++i) {
            uint256 count = handler.graduationCount(tokens[i]);
            assertLe(count, 1, "graduated more than once");
            bool graduated = pump.status(tokens[i]) == uint8(ZeroXPump.Lifecycle.GRADUATED);
            assertEq(graduated ? 1 : 0, count, "graduation ghost matches lifecycle");
            if (graduated) {
                (, uint256 tokenReserve, uint256 realReserve,,,,,,,,) = pump.markets(tokens[i]);
                assertEq(tokenReserve, 0, "graduated token reserve");
                assertEq(realReserve, 0, "graduated NUSD reserve");
            }
        }
    }

    function invariantTokenSupplyIsFixed() public view {
        for (uint256 i; i < tokens.length; ++i) {
            uint256 supply = PumpToken(tokens[i]).totalSupply();
            if (handler.graduationCount(tokens[i]) == 0) {
                assertEq(supply, SUPPLY, "pre-graduation supply fixed");
            } else {
                assertEq(supply, handler.supplyAtGraduation(tokens[i]), "post-graduation supply fixed");
                assertLe(supply, SUPPLY, "burn only");
            }
        }
    }

    function invariantLockerLpBalanceNeverDecreases() public view {
        assertFalse(handler.lockerLpDecreased(), "locker LP decreased");
        assertGe(adapter.lpToken().balanceOf(address(locker)), handler.lastLockerLpBalance(), "locker LP balance");
    }
}
