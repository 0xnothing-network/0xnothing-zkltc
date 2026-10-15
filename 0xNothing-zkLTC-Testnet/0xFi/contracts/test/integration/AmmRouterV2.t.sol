// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { ZeroXFiFactoryV2 } from "../../src/amm/ZeroXFiFactoryV2.sol";
import { ZeroXFiPair } from "../../src/amm/ZeroXFiPair.sol";
import { ZeroXFiRouterV2 } from "../../src/amm/ZeroXFiRouterV2.sol";
import { WzkLTC } from "../../src/amm/WzkLTC.sol";
import { TestBase } from "../helpers/TestBase.sol";
import { FeeSplitterMock } from "../mocks/FeeSplitterMock.sol";
import { MockPump } from "../mocks/GraduationMocks.sol";
import { MockERC20 } from "../mocks/TokenMocks.sol";

contract AmmRouterV2Test is TestBase {
    address private constant ALICE = address(0xA11CE);
    address private constant BOB = address(0xB0B);
    address private constant POOL = address(0xB001);
    address private constant TREASURY = address(0x7EA5);

    MockERC20 private nusd;
    MockERC20 private tokenA;
    MockERC20 private tokenB;
    MockERC20 private pumpToken;
    MockPump private pump;
    WzkLTC private wrapped;
    ZeroXFiFactoryV2 private factory;
    FeeSplitterMock private splitter;
    ZeroXFiRouterV2 private router;

    function setUp() public {
        vm.warp(1_000_000);
        nusd = new MockERC20("Nothing USD", "NUSD");
        tokenA = new MockERC20("Token A", "TKA");
        tokenB = new MockERC20("Token B", "TKB");
        pumpToken = new MockERC20("Pump token", "PUMP");
        pump = new MockPump(address(nusd));
        pump.setStatus(address(pumpToken), 2);
        wrapped = new WzkLTC();
        factory = new ZeroXFiFactoryV2(address(this), address(nusd), address(wrapped), address(pump));
        splitter = new FeeSplitterMock(address(nusd), POOL, TREASURY);
        router = new ZeroXFiRouterV2(address(factory), address(wrapped), address(splitter), TREASURY);
        factory.bindRouter(address(router));

        MockERC20[3] memory tokens = [nusd, tokenA, tokenB];
        for (uint256 i; i < tokens.length; ++i) {
            _fundAndApprove(ALICE, tokens[i], 10_000_000 ether);
            _fundAndApprove(BOB, tokens[i], 10_000_000 ether);
        }
        vm.deal(ALICE, 100_000 ether);
        vm.deal(BOB, 100_000 ether);
        vm.prank(BOB);
        IERC20(address(wrapped)).approve(address(router), type(uint256).max);

        _add(address(tokenA), address(nusd), 100_000 ether, 200_000 ether);
        _add(address(tokenB), address(nusd), 100_000 ether, 100_000 ether);
        _addNative(address(tokenA), 10_000 ether, 100 ether);
        _addNative(address(nusd), 50_000 ether, 500 ether);
    }

    // ---------------------------------------------------------------- factory

    function testEveryPairNeedsNusdOrWzkLTC() public {
        vm.expectRevert(ZeroXFiFactoryV2.BaseAssetRequired.selector);
        factory.createPair(address(tokenA), address(tokenB));
        assertTrue(factory.isBaseToken(address(nusd)) && factory.isBaseToken(address(wrapped)), "bases");
        assertFalse(factory.isBaseToken(address(tokenA)), "token is not a base");

        vm.expectRevert(ZeroXFiFactoryV2.ProtectedPumpPair.selector);
        factory.createPair(address(pumpToken), address(nusd));

        vm.prank(ALICE);
        vm.expectRevert(ZeroXFiFactoryV2.BaseAssetRequired.selector);
        router.addLiquidity(_addParams(address(tokenA), address(tokenB), 1 ether, 1 ether));
    }

    // ---------------------------------------------------------------- fee schedule

    function testBaseInputPaysTenBpsOutOfTheInput() public {
        address[] memory path = _path2(address(nusd), address(tokenA));
        (uint256 reserveIn, uint256 reserveOut) = router.getReserves(path[0], path[1]);
        ZeroXFiRouterV2.SwapQuote memory q = router.quoteSwap(1_000 ether, path);

        assertEq(q.feeIndex, 0, "fee on input");
        assertEq(q.feeBps, 10, "direct rate");
        assertEq(q.fee, 1 ether, "0.1% of input");
        assertEq(q.amounts[1], router.getAmountOut(999 ether, reserveIn, reserveOut), "LP 0.5% on the rest");

        uint256 out = _swap(path, 1_000 ether, q.amounts[1]);
        assertEq(out, q.amounts[1], "exact quote");
        assertEq(router.accruedRouterFees(address(nusd)), 1 ether, "accrued NUSD");
        assertEq(nusd.balanceOf(address(router)), 1 ether, "fee backed");
    }

    function testTokenToBasePaysTenBpsOutOfTheOutput() public {
        address[] memory path = _path2(address(tokenA), address(nusd));
        (uint256 reserveIn, uint256 reserveOut) = router.getReserves(path[0], path[1]);
        uint256 gross = router.getAmountOut(1_000 ether, reserveIn, reserveOut);
        ZeroXFiRouterV2.SwapQuote memory q = router.quoteSwap(1_000 ether, path);

        assertEq(q.feeIndex, 1, "fee on the base output");
        assertEq(q.fee, gross / 1000, "0.1% of gross output");
        assertEq(q.amounts[1], gross - q.fee, "user gets the rest");

        vm.prank(BOB);
        vm.expectRevert(ZeroXFiRouterV2.InsufficientOutputAmount.selector);
        router.swapExactTokensForTokens(1_000 ether, q.amounts[1] + 1, path, BOB, block.timestamp);

        uint256 out = _swap(path, 1_000 ether, q.amounts[1]);
        assertEq(out, q.amounts[1], "min-out holds after the fee");
        assertEq(router.accruedRouterFees(address(nusd)), q.fee, "accrued NUSD");
        assertEq(tokenA.balanceOf(address(router)), 0, "no token fee");
        (uint256 reserveInAfter, uint256 reserveOutAfter) = router.getReserves(path[0], path[1]);
        assertEq(reserveInAfter, reserveIn + 1_000 ether, "pair got the full input");
        assertEq(reserveOutAfter, reserveOut - gross, "pair paid the gross output");
    }

    function testCrossSwapPaysThirtyBpsOnTheIntermediateBase() public {
        address[] memory path = _path3(address(tokenA), address(nusd), address(tokenB));
        (uint256 r0In, uint256 r0Out) = router.getReserves(path[0], path[1]);
        (uint256 r1In, uint256 r1Out) = router.getReserves(path[1], path[2]);
        uint256 gross = router.getAmountOut(500 ether, r0In, r0Out);
        ZeroXFiRouterV2.SwapQuote memory q = router.quoteSwap(500 ether, path);

        assertEq(q.feeBps, 30, "cross rate");
        assertEq(q.feeIndex, 1, "fee on NUSD leg");
        assertEq(q.fee, gross * 30 / 10_000, "0.3% of the NUSD leg");
        assertEq(q.amounts[2], router.getAmountOut(gross - q.fee, r1In, r1Out), "second hop on net NUSD");

        uint256 out = _swap(path, 500 ether, q.amounts[2]);
        assertEq(out, q.amounts[2], "exact output");
        assertEq(router.accruedRouterFees(address(nusd)), q.fee, "accrued once");
        assertEq(nusd.balanceOf(address(router)), q.fee, "no residue beyond the fee");
    }

    function testCrossSwapThroughWzkLTCPaysTheFeeInWzkLTC() public {
        address[] memory path = new address[](4);
        (path[0], path[1], path[2], path[3]) = (address(tokenA), address(wrapped), address(nusd), address(tokenB));
        ZeroXFiRouterV2.SwapQuote memory q = router.quoteSwap(100 ether, path);
        assertEq(q.feeBps, 30, "cross rate");
        assertEq(q.feeIndex, 1, "fee on the WzkLTC leg");

        uint256 out = _swap(path, 100 ether, q.amounts[3]);
        assertEq(out, q.amounts[3], "exact output");
        assertEq(router.accruedRouterFees(address(wrapped)), q.fee, "accrued WzkLTC");
        assertEq(router.accruedRouterFees(address(nusd)), 0, "no NUSD fee");
        assertEq(IERC20(address(wrapped)).balanceOf(address(router)), q.fee, "fee backed");
    }

    function testRoutesWithABaseAtEitherEndStayAtTenBps() public {
        address[] memory path = _path3(address(nusd), address(tokenA), address(wrapped));
        assertEq(router.routerFeeBpsForPath(path), 10, "base to base via a token");
        path = _path3(address(tokenB), address(nusd), address(wrapped));
        ZeroXFiRouterV2.SwapQuote memory q = router.quoteSwap(100 ether, path);
        assertEq(q.feeBps, 10, "token to base via a base");
        assertEq(q.feeIndex, 1, "first base leg");
        _swap(path, 100 ether, q.amounts[2]);
        assertEq(router.accruedRouterFees(address(nusd)), q.fee, "fee in the first base");
    }

    function testNativeInAndOutChargeTheWzkLTCLeg() public {
        address[] memory path = _path2(address(wrapped), address(tokenA));
        ZeroXFiRouterV2.SwapQuote memory q = router.quoteSwap(10 ether, path);
        assertEq(q.fee, 0.01 ether, "0.1% of native input");
        vm.prank(BOB);
        uint256[] memory amounts =
            router.swapExactNativeForTokens{ value: 10 ether }(q.amounts[1], path, BOB, block.timestamp);
        assertEq(amounts[1], q.amounts[1], "native in");
        assertEq(router.accruedRouterFees(address(wrapped)), 0.01 ether, "accrued from input");

        path = _path2(address(tokenA), address(wrapped));
        q = router.quoteSwap(500 ether, path);
        assertEq(q.feeIndex, 1, "fee on the WzkLTC output");
        uint256 nativeBefore = BOB.balance;
        vm.prank(BOB);
        router.swapExactTokensForNative(500 ether, q.amounts[1], path, BOB, block.timestamp);
        assertEq(BOB.balance - nativeBefore, q.amounts[1], "native out net of fee");
        assertEq(router.accruedRouterFees(address(wrapped)), 0.01 ether + q.fee, "both fees accrued");
        assertEq(
            IERC20(address(wrapped)).balanceOf(address(router)),
            router.accruedRouterFees(address(wrapped)),
            "router holds only fees"
        );
    }

    // ---------------------------------------------------------------- distribution

    function testAnyoneDistributesNusdThroughTheSplitterAndWzkLTCToItsRecipient() public {
        _swap(_path2(address(tokenA), address(nusd)), 10_000 ether, 0);
        _swap(_path2(address(tokenA), address(wrapped)), 1_000 ether, 0);
        uint256 nusdFees = router.accruedRouterFees(address(nusd));
        uint256 wzkFees = router.accruedRouterFees(address(wrapped));

        vm.prank(address(0xCAFE));
        router.distributeFees(address(nusd));
        assertEq(nusd.balanceOf(POOL), nusdFees * 7_000 / 10_000, "70% to stakers");
        assertEq(nusd.balanceOf(TREASURY), nusdFees * 1_000 / 10_000, "10% to treasury");
        assertEq(nusd.balanceOf(address(splitter)), 0, "split immediately");

        router.distributeFees(address(wrapped));
        assertEq(IERC20(address(wrapped)).balanceOf(TREASURY), wzkFees, "all WzkLTC to the native recipient");
        assertEq(IERC20(address(wrapped)).balanceOf(POOL), 0, "stakers only take NUSD");

        vm.expectRevert(ZeroXFiRouterV2.NothingToDistribute.selector);
        router.distributeFees(address(nusd));
        vm.expectRevert(ZeroXFiRouterV2.NothingToDistribute.selector);
        router.distributeFees(address(tokenA));
    }

    /// v3 wiring: the splitter is also the native-fee recipient, so WzkLTC fees back NUSD.
    function testTheSplitterCanAlsoReceiveWzkLTCFees() public {
        ZeroXFiRouterV2 wired =
            new ZeroXFiRouterV2(address(factory), address(wrapped), address(splitter), address(splitter));
        assertEq(wired.feeSplitter(), address(splitter), "NUSD fees");
        assertEq(wired.treasury(), address(splitter), "WzkLTC fees");
    }

    function testConstructorRejectsMismatchedWiring() public {
        WzkLTC otherWrapped = new WzkLTC();
        vm.expectRevert(ZeroXFiRouterV2.InvalidConfiguration.selector);
        new ZeroXFiRouterV2(address(factory), address(otherWrapped), address(splitter), TREASURY);
        vm.expectRevert(ZeroXFiRouterV2.InvalidConfiguration.selector);
        new ZeroXFiRouterV2(address(factory), address(wrapped), address(splitter), address(0));
        vm.expectRevert(ZeroXFiFactoryV2.InvalidContract.selector);
        new ZeroXFiFactoryV2(address(this), address(nusd), address(nusd), address(pump));
    }

    /// Every route: the user gets exactly the quote, the fee is 10/30 bps of the first base leg,
    /// and the router never holds anything but accrued fees.
    function testFuzzEveryRouteChargesTheScheduledFee(uint256 rawAmount, uint8 rawRoute) public {
        address[] memory path = _route(rawRoute % 6);
        uint256 amountIn = bound(rawAmount, 1e9, 20_000 ether);
        if (path[0] == address(wrapped)) amountIn = bound(rawAmount, 1e9, 50 ether);

        bool baseIn = factory.isBaseToken(path[0]);
        bool baseOut = factory.isBaseToken(path[path.length - 1]);
        uint256 expectedBps = baseIn || baseOut ? 10 : 30;
        uint256 expectedFee;
        if (baseIn) {
            expectedFee = amountIn * expectedBps / 10_000;
        } else {
            (uint256 reserveIn, uint256 reserveOut) = router.getReserves(path[0], path[1]);
            expectedFee = router.getAmountOut(amountIn, reserveIn, reserveOut) * expectedBps / 10_000;
        }
        ZeroXFiRouterV2.SwapQuote memory q = router.quoteSwap(amountIn, path);
        assertEq(q.feeBps, expectedBps, "rate");
        assertEq(q.fee, expectedFee, "fee amount");
        address feeToken = path[q.feeIndex];

        uint256 out = _swap(path, amountIn, q.amounts[path.length - 1]);
        assertEq(out, q.amounts[path.length - 1], "exact output");
        assertEq(router.accruedRouterFees(feeToken), q.fee, "accrued");
        assertEq(IERC20(feeToken).balanceOf(address(router)), q.fee, "router holds only the fee");
        for (uint256 i; i < path.length; ++i) {
            if (path[i] == feeToken) continue;
            assertEq(IERC20(path[i]).balanceOf(address(router)), 0, "residue left in router");
        }
    }

    // ---------------------------------------------------------------- helpers

    function _route(uint256 index) private view returns (address[] memory path) {
        if (index == 0) return _path2(address(nusd), address(tokenA));
        if (index == 1) return _path2(address(tokenA), address(nusd));
        if (index == 2) return _path3(address(tokenA), address(nusd), address(tokenB));
        if (index == 3) return _path3(address(nusd), address(tokenA), address(wrapped));
        if (index == 4) return _path3(address(tokenB), address(nusd), address(wrapped));
        path = new address[](4);
        (path[0], path[1], path[2], path[3]) = (address(tokenA), address(wrapped), address(nusd), address(tokenB));
    }

    function _swap(address[] memory path, uint256 amountIn, uint256 minOut) private returns (uint256 out) {
        IERC20 output = IERC20(path[path.length - 1]);
        uint256 before = output.balanceOf(BOB);
        if (path[0] == address(wrapped)) {
            vm.prank(BOB);
            wrapped.deposit{ value: amountIn }();
        }
        vm.prank(BOB);
        router.swapExactTokensForTokens(amountIn, minOut, path, BOB, block.timestamp);
        out = output.balanceOf(BOB) - before;
    }

    function _path2(address a, address b) private pure returns (address[] memory path) {
        path = new address[](2);
        (path[0], path[1]) = (a, b);
    }

    function _path3(address a, address b, address c) private pure returns (address[] memory path) {
        path = new address[](3);
        (path[0], path[1], path[2]) = (a, b, c);
    }

    function _add(address a, address b, uint256 amountA, uint256 amountB) private {
        vm.prank(ALICE);
        router.addLiquidity(_addParams(a, b, amountA, amountB));
    }

    function _addNative(address token, uint256 amountToken, uint256 amountNative) private {
        vm.prank(ALICE);
        router.addLiquidityNative{ value: amountNative }(
            ZeroXFiRouterV2.AddLiquidityNativeParams({
                token: token,
                amountTokenDesired: amountToken,
                amountTokenMin: amountToken,
                amountNativeMin: amountNative,
                minimumLiquidity: 1,
                to: ALICE,
                deadline: block.timestamp
            })
        );
    }

    function _addParams(address a, address b, uint256 amountA, uint256 amountB)
        private
        view
        returns (ZeroXFiRouterV2.AddLiquidityParams memory)
    {
        return ZeroXFiRouterV2.AddLiquidityParams({
            tokenA: a,
            tokenB: b,
            amountADesired: amountA,
            amountBDesired: amountB,
            amountAMin: amountA,
            amountBMin: amountB,
            minimumLiquidity: 1,
            to: ALICE,
            deadline: block.timestamp
        });
    }

    function _fundAndApprove(address account, MockERC20 token, uint256 amount) private {
        token.mint(account, amount);
        vm.prank(account);
        token.approve(address(router), type(uint256).max);
    }
}
