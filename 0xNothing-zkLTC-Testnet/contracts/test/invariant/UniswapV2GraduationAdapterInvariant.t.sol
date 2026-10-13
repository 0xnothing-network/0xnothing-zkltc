// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {InvariantBase} from "../InvariantBase.sol";
import {TestBase} from "../TestBase.sol";
import {GraduationRouter} from "../../src/graduation/GraduationRouter.sol";
import {PermanentLiquidityLocker} from "../../src/graduation/PermanentLiquidityLocker.sol";
import {UniswapV2GraduationAdapter} from "../../src/graduation/UniswapV2GraduationAdapter.sol";
import {IUniswapV2Pair} from "../../src/graduation/interfaces/IUniswapV2Pair.sol";
import {NUSD} from "../../src/nusd/NUSD.sol";
import {MockLPToken} from "../mocks/MockGraduationAdapter.sol";
import {MockUniswapV2Factory, MockUniswapV2Pair} from "../mocks/MockUniswapV2.sol";

contract UniV2GraduationHandler is TestBase {
    uint256 public constant TOKEN_IN = 400 ether;
    uint256 public constant NUSD_IN = 100 ether;

    NUSD public immutable nusd;
    GraduationRouter public immutable router;
    UniswapV2GraduationAdapter public immutable adapter;
    MockUniswapV2Factory public immutable factory;
    address public immutable locker;
    MockLPToken[] public tokens;

    uint256 public lastLockerLp;
    bool public lockerLpDecreased;
    bool public adapterHeldFunds;
    bool public graduatedWithDustReserves;
    uint256 public successfulGraduations;

    constructor(
        NUSD nusd_,
        GraduationRouter router_,
        UniswapV2GraduationAdapter adapter_,
        MockUniswapV2Factory factory_,
        address locker_,
        MockLPToken[] memory tokens_
    ) {
        nusd = nusd_;
        router = router_;
        adapter = adapter_;
        factory = factory_;
        locker = locker_;
        tokens = tokens_;
        nusd_.approve(address(router_), type(uint256).max);
        for (uint256 i; i < tokens_.length; ++i) {
            tokens_[i].approve(address(router_), type(uint256).max);
        }
    }

    function prepare(uint256 tokenSeed) external {
        adapter.preparePool(address(_token(tokenSeed)));
        _track();
    }

    function donate(uint256 tokenSeed, uint256 tokenAmount, uint256 nusdAmount) external {
        MockLPToken token = _token(tokenSeed);
        address pair = factory.getPair(address(token), address(nusd));
        if (pair == address(0)) {
            adapter.preparePool(address(token));
            pair = factory.getPair(address(token), address(nusd));
        }
        tokenAmount = 1 + (tokenAmount % 20 ether);
        nusdAmount = nusdAmount % 5 ether;
        token.mint(pair, tokenAmount);
        if (nusdAmount != 0 && nusd.balanceOf(address(this)) >= nusdAmount) {
            nusd.transfer(pair, nusdAmount);
        }
        _track();
    }

    function syncPair(uint256 tokenSeed) external {
        address pair = factory.getPair(address(_token(tokenSeed)), address(nusd));
        if (pair != address(0)) {
            try IUniswapV2Pair(pair).sync() {} catch {}
        }
        _track();
    }

    function seedBalanced(uint256 tokenSeed) external {
        MockLPToken token = _token(tokenSeed);
        adapter.preparePool(address(token));
        address pair = factory.getPair(address(token), address(nusd));
        if (IUniswapV2Pair(pair).totalSupply() != 0) {
            _track();
            return;
        }
        if (nusd.balanceOf(address(this)) < 10 ether) {
            _track();
            return;
        }
        token.mint(pair, 40 ether);
        nusd.transfer(pair, 10 ether);
        try MockUniswapV2Pair(pair).mint(address(this)) {} catch {}
        _track();
    }

    function graduate(uint256 tokenSeed) external {
        MockLPToken token = _token(tokenSeed);
        adapter.preparePool(address(token));
        try adapter.quoteMinimumLp(address(token), address(nusd), TOKEN_IN, NUSD_IN) returns (uint256 minLp) {
            if (nusd.balanceOf(address(this)) < NUSD_IN) {
                _track();
                return;
            }
            token.mint(address(this), TOKEN_IN);
            try router.executeGraduation(
                address(adapter), address(token), address(nusd), TOKEN_IN, NUSD_IN, minLp, type(uint256).max
            ) {
                ++successfulGraduations;
                address pair = factory.getPair(address(token), address(nusd));
                if (token.balanceOf(pair) < TOKEN_IN || nusd.balanceOf(pair) < NUSD_IN) {
                    graduatedWithDustReserves = true;
                }
            } catch {}
        } catch {}
        _track();
    }

    function tokenCount() external view returns (uint256) {
        return tokens.length;
    }

    function _token(uint256 seed) private view returns (MockLPToken) {
        return tokens[seed % tokens.length];
    }

    function _track() private {
        uint256 lockerLp;
        for (uint256 i; i < tokens.length; ++i) {
            address pair = factory.getPair(address(tokens[i]), address(nusd));
            if (pair != address(0)) lockerLp += MockUniswapV2Pair(pair).balanceOf(locker);
            if (tokens[i].balanceOf(address(adapter)) != 0) adapterHeldFunds = true;
        }
        if (nusd.balanceOf(address(adapter)) != 0) adapterHeldFunds = true;
        if (lockerLp < lastLockerLp) lockerLpDecreased = true;
        lastLockerLp = lockerLp;
    }
}

contract UniswapV2GraduationAdapterInvariantTest is InvariantBase {
    uint256 private constant MARKETS = 3;

    NUSD private nusd;
    PermanentLiquidityLocker private locker;
    UniswapV2GraduationAdapter private adapter;
    UniV2GraduationHandler private handler;

    function setUp() public {
        vm.warp(1_000_000);
        nusd = new NUSD(address(this));
        nusd.bindVault(address(this));
        locker = new PermanentLiquidityLocker(address(this));
        GraduationRouter router = new GraduationRouter(address(this), 1 hours, address(locker));
        locker.bindRouter(address(router));
        MockUniswapV2Factory factory = new MockUniswapV2Factory();
        adapter = new UniswapV2GraduationAdapter(address(factory), address(nusd), address(router), 200, 100);
        router.bindPump(address(handlerPlaceholder(router, factory)));
        router.scheduleAdapter(address(adapter));
        router.scheduleEnable();
        vm.warp(1_000_000 + 1 hours);
        router.activateAdapter(address(adapter));
        router.enableRouter();
    }

    function handlerPlaceholder(GraduationRouter router, MockUniswapV2Factory factory) private returns (address) {
        MockLPToken[] memory tokens = new MockLPToken[](MARKETS);
        for (uint256 i; i < MARKETS; ++i) {
            tokens[i] = new MockLPToken();
        }
        handler = new UniV2GraduationHandler(nusd, router, adapter, factory, address(locker), tokens);
        nusd.mint(address(handler), 1_000_000 ether);
        targetContract(address(handler));
        return address(handler);
    }

    function invariantAdapterNeverHoldsFunds() public view {
        assertFalse(handler.adapterHeldFunds(), "adapter residual");
        assertEq(nusd.balanceOf(address(adapter)), 0, "adapter NUSD");
    }

    function invariantLockerLpNeverDecreases() public view {
        assertFalse(handler.lockerLpDecreased(), "locker LP fell");
    }

    function invariantFreshOrBalancedGraduationKeepsDepositedReserves() public view {
        assertFalse(handler.graduatedWithDustReserves(), "reserves below deposit");
    }
}
