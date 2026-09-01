// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { ZeroXFiFactory } from "../../src/amm/ZeroXFiFactory.sol";
import { ZeroXFiPair } from "../../src/amm/ZeroXFiPair.sol";
import { ZeroXFiRouter } from "../../src/amm/ZeroXFiRouter.sol";
import { WzkLTC } from "../../src/amm/WzkLTC.sol";
import { ZeroXFiGraduationAdapter } from "../../src/graduation/ZeroXFiGraduationAdapter.sol";
import { IGraduationAdapter } from "../../src/interfaces/IGraduationAdapter.sol";
import { TestBase } from "../helpers/TestBase.sol";
import { MockPump, MockPumpRouter } from "../mocks/GraduationMocks.sol";
import { MockERC20 } from "../mocks/TokenMocks.sol";

contract GraduationAdapterTest is TestBase {
    address private constant USER = address(0xBEEF);

    MockERC20 private nusd;
    MockERC20 private pumpToken;
    MockPump private pump;
    MockPumpRouter private pumpRouter;
    ZeroXFiFactory private factory;
    ZeroXFiGraduationAdapter private adapter;
    ZeroXFiRouter private dexRouter;

    function setUp() public {
        vm.warp(1_000_000);
        nusd = new MockERC20("Nothing USD", "NUSD");
        pumpToken = new MockERC20("Pump token", "PUMP");
        pump = new MockPump(address(nusd));
        pumpRouter = new MockPumpRouter(address(pump));
        pump.setGraduationRouter(address(pumpRouter));
        pump.setStatus(address(pumpToken), 3);

        factory = new ZeroXFiFactory(address(this), address(nusd), address(pump));
        adapter = new ZeroXFiGraduationAdapter(address(factory), address(pumpRouter), address(nusd), address(pump));
        factory.bindGraduationAdapter(address(adapter));
        dexRouter = new ZeroXFiRouter(address(factory), address(new WzkLTC()));
        factory.bindRouter(address(dexRouter));
    }

    function testProtectedPairCannotBeCreatedOrBootstrappedPublicly() public {
        vm.expectRevert(ZeroXFiFactory.ProtectedPumpPair.selector);
        factory.createPair(address(pumpToken), address(nusd));

        address pair = adapter.preparePool(address(pumpToken));
        assertEq(ZeroXFiPair(pair).bootstrapper(), address(adapter), "adapter bootstrap lock");

        pumpToken.mint(USER, 1_000_000 ether);
        nusd.mint(USER, 1000 ether);
        vm.startPrank(USER);
        pumpToken.approve(address(dexRouter), type(uint256).max);
        nusd.approve(address(dexRouter), type(uint256).max);
        vm.expectRevert(ZeroXFiPair.Forbidden.selector);
        dexRouter.addLiquidity(
            ZeroXFiRouter.AddLiquidityParams({
                tokenA: address(pumpToken),
                tokenB: address(nusd),
                amountADesired: 1_000_000 ether,
                amountBDesired: 1000 ether,
                amountAMin: 1_000_000 ether,
                amountBMin: 1000 ether,
                minimumLiquidity: 1,
                to: USER,
                deadline: block.timestamp + 1
            })
        );
        vm.stopPrank();
        assertEq(pumpToken.balanceOf(pair), 0, "failed public seed rolled back");
        assertEq(nusd.balanceOf(pair), 0, "failed public NUSD seed rolled back");
    }

    function testGraduationSweepsDonationsAndSeedsExactTerminalRatio() public {
        address pair = adapter.preparePool(address(pumpToken));
        pumpToken.mint(pair, 7 ether);
        nusd.mint(pair, 3 ether);

        uint256 tokenAmount = 250_000_000 ether;
        uint256 nusdAmount = 1500 ether;
        pumpToken.mint(address(pumpRouter), tokenAmount);
        nusd.mint(address(pumpRouter), nusdAmount);
        IGraduationAdapter.GraduationResult memory result = pumpRouter.execute(
            adapter, address(pumpToken), address(nusd), tokenAmount, nusdAmount, 1, block.timestamp + 1
        );

        assertEq(result.dex, address(factory), "DEX factory");
        assertEq(result.pool, pair, "pool result");
        assertEq(result.lpToken, pair, "fungible pair LP");
        assertEq(result.pairId, factory.pairId(address(pumpToken), address(nusd)), "canonical pair id");
        assertGt(result.lpAmount, 0, "LP minted");
        assertEq(IERC20(pair).balanceOf(address(pumpRouter)), result.lpAmount, "router receives LP");
        assertEq(ZeroXFiPair(pair).bootstrapper(), address(0), "bootstrap lock cleared");

        (uint256 reserveToken, uint256 reserveNusd) = dexRouter.getReserves(address(pumpToken), address(nusd));
        assertEq(reserveToken, tokenAmount, "exact token reserve");
        assertEq(reserveNusd, nusdAmount, "exact NUSD reserve");
        assertEq(pumpToken.balanceOf(address(1)), 7 ether, "forced token donation sunk");
        assertEq(nusd.balanceOf(address(1)), 3 ether, "forced NUSD donation sunk");
        assertEq(pumpToken.balanceOf(address(adapter)), 0, "adapter token dust");
        assertEq(nusd.balanceOf(address(adapter)), 0, "adapter NUSD dust");
    }

    function testOnlyPinnedPumpRouterCanGraduate() public {
        adapter.preparePool(address(pumpToken));
        vm.expectRevert(ZeroXFiGraduationAdapter.InvalidGraduationCaller.selector);
        adapter.graduate(
            IGraduationAdapter.GraduationParams({
                token: address(pumpToken),
                nusd: address(nusd),
                tokenAmount: 1 ether,
                nusdAmount: 1 ether,
                minimumLp: 1,
                deadline: block.timestamp + 1,
                lpRecipient: address(pumpRouter)
            })
        );
    }

    function testFuzzGraduationConsumesExactAmounts(uint96 rawTokenAmount, uint96 rawNusdAmount) public {
        uint256 tokenAmount = bound(rawTokenAmount, 1e12, 1e27);
        uint256 nusdAmount = bound(rawNusdAmount, 1e12, 1e24);
        address pair = adapter.preparePool(address(pumpToken));
        pumpToken.mint(address(pumpRouter), tokenAmount);
        nusd.mint(address(pumpRouter), nusdAmount);

        IGraduationAdapter.GraduationResult memory result = pumpRouter.execute(
            adapter, address(pumpToken), address(nusd), tokenAmount, nusdAmount, 1, block.timestamp + 1
        );
        assertGt(result.lpAmount, 0, "fuzz LP");
        (uint256 reserveToken, uint256 reserveNusd) = dexRouter.getReserves(address(pumpToken), address(nusd));
        assertEq(reserveToken, tokenAmount, "fuzz exact token");
        assertEq(reserveNusd, nusdAmount, "fuzz exact NUSD");
        assertEq(IERC20(pair).totalSupply(), result.lpAmount + ZeroXFiPair(pair).MINIMUM_LIQUIDITY(), "LP supply");
    }
}
