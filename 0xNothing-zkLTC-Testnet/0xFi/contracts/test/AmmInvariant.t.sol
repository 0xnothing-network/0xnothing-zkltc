// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { ZeroXFiFactory } from "../src/amm/ZeroXFiFactory.sol";
import { ZeroXFiPair } from "../src/amm/ZeroXFiPair.sol";
import { ZeroXFiRouter } from "../src/amm/ZeroXFiRouter.sol";
import { WzkLTC } from "../src/amm/WzkLTC.sol";
import { TestBase } from "./TestBase.sol";
import { MockERC20, MockPump } from "./mocks/Mocks.sol";

contract SwapHandler {
    MockERC20 public immutable token0;
    MockERC20 public immutable token1;
    ZeroXFiRouter public immutable router;

    constructor(MockERC20 token0_, MockERC20 token1_, ZeroXFiRouter router_) {
        token0 = token0_;
        token1 = token1_;
        router = router_;
        token0_.approve(address(router_), type(uint256).max);
        token1_.approve(address(router_), type(uint256).max);
    }

    function swap0For1(uint96 seed) external {
        _swap(token0, token1, seed);
    }

    function swap1For0(uint96 seed) external {
        _swap(token1, token0, seed);
    }

    function _swap(MockERC20 input, MockERC20 output, uint96 seed) private {
        uint256 balance = input.balanceOf(address(this));
        if (balance < 1e9) return;
        uint256 amountIn = 1e9 + (uint256(seed) % (balance / 100 + 1));
        address[] memory path = new address[](2);
        path[0] = address(input);
        path[1] = address(output);
        try router.swapExactTokensForTokens(amountIn, 0, path, address(this), block.timestamp) { } catch { }
    }
}

contract AmmInvariantTest is TestBase {
    MockERC20 private tokenA;
    MockERC20 private tokenB;
    ZeroXFiPair private pair;
    ZeroXFiRouter private router;
    uint256 private initialK;
    address[] private invariantTargets;

    // Foundry probes the optional StdInvariant configuration getters. Every
    // unknown getter returns an ABI-compatible empty dynamic array.
    fallback() external {
        bytes memory emptyArray = abi.encode(new address[](0));
        assembly ("memory-safe") {
            return(add(emptyArray, 32), mload(emptyArray))
        }
    }

    function setUp() public {
        tokenA = new MockERC20("Token A", "A");
        tokenB = new MockERC20("Token B", "B");
        MockPump pump = new MockPump(address(tokenB));
        ZeroXFiFactory factory = new ZeroXFiFactory(address(this), address(tokenB), address(pump));
        router = new ZeroXFiRouter(address(factory), address(new WzkLTC()));
        factory.bindRouter(address(router));

        tokenA.mint(address(this), 1_000_000 ether);
        tokenB.mint(address(this), 1_000_000 ether);
        tokenA.approve(address(router), type(uint256).max);
        tokenB.approve(address(router), type(uint256).max);
        router.addLiquidity(
            ZeroXFiRouter.AddLiquidityParams({
                tokenA: address(tokenA),
                tokenB: address(tokenB),
                amountADesired: 500_000 ether,
                amountBDesired: 500_000 ether,
                amountAMin: 500_000 ether,
                amountBMin: 500_000 ether,
                minimumLiquidity: 1,
                to: address(this),
                deadline: block.timestamp
            })
        );
        pair = ZeroXFiPair(factory.getPair(address(tokenA), address(tokenB)));
        (uint112 reserve0, uint112 reserve1,) = pair.getReserves();
        initialK = uint256(reserve0) * reserve1;

        SwapHandler handler = new SwapHandler(tokenA, tokenB, router);
        tokenA.mint(address(handler), 1_000_000 ether);
        tokenB.mint(address(handler), 1_000_000 ether);
        invariantTargets.push(address(handler));
    }

    function targetContracts() external view returns (address[] memory) {
        return invariantTargets;
    }

    function invariantReservesMatchBalances() public view {
        (uint112 reserve0, uint112 reserve1,) = pair.getReserves();
        assertEq(MockERC20(pair.token0()).balanceOf(address(pair)), reserve0, "token0 reserve accounting");
        assertEq(MockERC20(pair.token1()).balanceOf(address(pair)), reserve1, "token1 reserve accounting");
    }

    function invariantConstantProductNeverDecreases() public view {
        (uint112 reserve0, uint112 reserve1,) = pair.getReserves();
        assertGe(uint256(reserve0) * reserve1, initialK, "swap invariant");
    }

    function invariantRouterFeesRemainBacked() public view {
        assertGe(
            tokenA.balanceOf(address(router)), router.accruedRouterFees(address(tokenA)), "token A router fee backing"
        );
        assertGe(
            tokenB.balanceOf(address(router)), router.accruedRouterFees(address(tokenB)), "token B router fee backing"
        );
    }
}
