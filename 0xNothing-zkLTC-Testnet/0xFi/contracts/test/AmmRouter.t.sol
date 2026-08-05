// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { ZeroXFiFactory } from "../src/amm/ZeroXFiFactory.sol";
import { ZeroXFiPair } from "../src/amm/ZeroXFiPair.sol";
import { ZeroXFiRouter } from "../src/amm/ZeroXFiRouter.sol";
import { WzkLTC } from "../src/amm/WzkLTC.sol";
import { TestBase } from "./TestBase.sol";
import { MockERC20, MockFeeOnTransferToken, MockPump } from "./mocks/Mocks.sol";

contract AmmRouterTest is TestBase {
    address private constant ALICE = address(0xA11CE);
    address private constant BOB = address(0xB0B);
    address private constant GUARDIAN = address(0xBEEF);

    MockERC20 private nusd;
    MockERC20 private token;
    MockERC20 private pumpToken;
    MockPump private pump;
    ZeroXFiFactory private factory;
    WzkLTC private wrapped;
    ZeroXFiRouter private router;

    function setUp() public {
        vm.warp(1_000_000);
        nusd = new MockERC20("Nothing USD", "NUSD");
        token = new MockERC20("Token", "TKN");
        pumpToken = new MockERC20("Pump token", "PUMP");
        pump = new MockPump(address(nusd));
        pump.setStatus(address(pumpToken), 2);
        factory = new ZeroXFiFactory(address(this), address(nusd), address(pump));
        wrapped = new WzkLTC();
        router = new ZeroXFiRouter(address(factory), address(wrapped));
        factory.bindRouter(address(router));

        _fundAndApprove(ALICE, token, 1_000_000 ether);
        _fundAndApprove(ALICE, nusd, 1_000_000 ether);
        _fundAndApprove(BOB, token, 1_000_000 ether);
        _fundAndApprove(BOB, nusd, 1_000_000 ether);
        vm.deal(ALICE, 10_000 ether);
        vm.deal(BOB, 10_000 ether);
    }

    function testTenProvidersJoinOneCanonicalPool() public {
        for (uint256 i; i < 10; ++i) {
            // The bounded loop value is far below uint160.max.
            // forge-lint: disable-next-line(unsafe-typecast)
            address provider = address(uint160(0x1000 + i));
            _fundAndApprove(provider, token, 1000 ether);
            _fundAndApprove(provider, nusd, 2000 ether);
            vm.prank(provider);
            (,, uint256 liquidity) = router.addLiquidity(_addParams(provider, 1000 ether, 2000 ether));
            assertGt(liquidity, 0, "provider LP");
        }

        address pair = factory.getPair(address(token), address(nusd));
        assertTrue(pair != address(0), "pair exists");
        assertEq(factory.allPairsLength(), 1, "one shared pool");
        (uint256 reserveToken, uint256 reserveNusd) = router.getReserves(address(token), address(nusd));
        assertEq(reserveToken, 10_000 ether, "combined token reserve");
        assertEq(reserveNusd, 20_000 ether, "combined NUSD reserve");
    }

    function testSwapChargesFeeAndPreservesConstantProduct() public {
        _seedStandardPair();
        address pair = factory.getPair(address(token), address(nusd));
        assertEq(ZeroXFiPair(pair).LP_FEE_BPS(), 50, "pair LP fee");
        assertEq(router.PROTOCOL_FEE_BPS(), 10, "direct protocol fee");
        (uint256 tokenReserveBefore, uint256 nusdReserveBefore) = router.getReserves(address(token), address(nusd));
        uint256 kBefore = _constantProduct(pair);

        address[] memory path = new address[](2);
        path[0] = address(token);
        path[1] = address(nusd);
        uint256 grossAmount = 100 ether;
        uint256 routerFee = router.routerFeeFor(grossAmount, path.length);
        assertEq(routerFee, 0.1 ether, "direct router fee");
        assertEq(router.routerFeeBpsForPathLength(path.length), 10, "direct router bps");
        uint256 quoted = router.getAmountsOut(grossAmount, path)[1];
        assertEq(
            quoted,
            router.getFirstHopAmountOut(grossAmount, tokenReserveBefore, nusdReserveBefore, path.length),
            "quote uses combined first-hop fee"
        );
        uint256 amountInWithCombinedFee = grossAmount * (10_000 - 60);
        assertEq(
            quoted,
            (amountInWithCombinedFee * nusdReserveBefore) / (tokenReserveBefore * 10_000 + amountInWithCombinedFee),
            "direct nominal fee is exactly 60 bps"
        );
        uint256 nusdBefore = nusd.balanceOf(BOB);
        vm.prank(BOB);
        router.swapExactTokensForTokens(grossAmount, quoted, path, BOB, block.timestamp + 1);
        assertEq(nusd.balanceOf(BOB) - nusdBefore, quoted, "exact quoted output");
        assertEq(router.accruedRouterFees(address(token)), routerFee, "router fee accrued");
        assertEq(token.balanceOf(address(router)), routerFee, "router fee backed");
        {
            (uint256 tokenReserveAfter, uint256 nusdReserveAfter) = router.getReserves(address(token), address(nusd));
            assertEq(tokenReserveAfter, tokenReserveBefore + grossAmount - routerFee, "pair receives net input");
            assertEq(nusdReserveAfter, nusdReserveBefore - quoted, "pair sends quoted output");
        }
        assertGe(_constantProduct(pair), kBefore, "constant product nondecreasing");
    }

    function testMultihopChargesProtocolAndRouteSurchargeOnlyOnce() public {
        _seedStandardPair();
        MockERC20 outputToken = new MockERC20("Output", "OUT");
        _fundAndApprove(ALICE, outputToken, 1_000_000 ether);
        _fundAndApprove(BOB, outputToken, 1_000_000 ether);
        vm.prank(ALICE);
        router.addLiquidity(
            ZeroXFiRouter.AddLiquidityParams({
                tokenA: address(nusd),
                tokenB: address(outputToken),
                amountADesired: 200_000 ether,
                amountBDesired: 100_000 ether,
                amountAMin: 200_000 ether,
                amountBMin: 100_000 ether,
                minimumLiquidity: 1,
                to: ALICE,
                deadline: block.timestamp + 1
            })
        );

        address[] memory path = new address[](3);
        path[0] = address(token);
        path[1] = address(nusd);
        path[2] = address(outputToken);
        uint256 grossAmount = 100 ether;
        uint256 totalRouterFee = router.routerFeeFor(grossAmount, path.length);
        assertEq(totalRouterFee, 0.2 ether, "protocol plus one route surcharge");
        assertEq(router.routerFeeBpsForPathLength(path.length), 20, "multihop router bps");
        uint256[] memory quoted = router.getAmountsOut(grossAmount, path);
        (uint256 firstReserveIn, uint256 firstReserveOut) = router.getReserves(path[0], path[1]);
        (uint256 secondReserveIn, uint256 secondReserveOut) = router.getReserves(path[1], path[2]);
        uint256 firstOut = router.getFirstHopAmountOut(grossAmount, firstReserveIn, firstReserveOut, path.length);
        assertEq(quoted[1], firstOut, "first hop quotes 50 LP plus 20 router bps");
        assertEq(quoted[2], router.getAmountOut(firstOut, secondReserveIn, secondReserveOut), "second hop LP fee only");

        uint256 outputBefore = outputToken.balanceOf(BOB);
        vm.prank(BOB);
        router.swapExactTokensForTokens(grossAmount, quoted[2], path, BOB, block.timestamp + 1);
        assertEq(outputToken.balanceOf(BOB) - outputBefore, quoted[2], "multihop exact output");
        assertEq(router.accruedRouterFees(address(token)), totalRouterFee, "one input-token accrual");
        assertEq(router.accruedRouterFees(address(nusd)), 0, "no intermediate surcharge");
        assertEq(router.accruedRouterFees(address(outputToken)), 0, "no output surcharge");
    }

    function testPathBoundsAndRepeatedTokensAreRejected() public {
        assertEq(router.routerFeeFor(1 ether, 4), 0.002 ether, "three-hop surcharge charged once");
        assertEq(router.routerFeeBpsForPathLength(4), 20, "three-hop router bps");

        address[] memory repeated = new address[](3);
        repeated[0] = address(token);
        repeated[1] = address(nusd);
        repeated[2] = address(token);
        vm.expectRevert(ZeroXFiRouter.InvalidPath.selector);
        router.getAmountsOut(1 ether, repeated);

        address[] memory tooLong = new address[](5);
        tooLong[0] = address(token);
        tooLong[1] = address(nusd);
        tooLong[2] = address(0x1001);
        tooLong[3] = address(0x1002);
        tooLong[4] = address(0x1003);
        vm.expectRevert(ZeroXFiRouter.InvalidPath.selector);
        router.getAmountsOut(1 ether, tooLong);
    }

    function testPairSwapCannotBypassBoundRouter() public {
        _seedStandardPair();
        ZeroXFiPair pair = ZeroXFiPair(factory.getPair(address(token), address(nusd)));
        vm.expectRevert(ZeroXFiPair.Forbidden.selector);
        vm.prank(BOB);
        pair.swap(0, 1, BOB);

        vm.expectRevert(ZeroXFiFactory.RouterAlreadyBound.selector);
        factory.bindRouter(address(router));
    }

    function testRouterRecoveryRequiresDelayAndGuardianCanOnlyPauseOrCancel() public {
        ZeroXFiRouter replacement = new ZeroXFiRouter(address(factory), address(wrapped));
        ZeroXFiFactory foreignFactory = new ZeroXFiFactory(address(this), address(nusd), address(pump));
        ZeroXFiRouter foreignRouter = new ZeroXFiRouter(address(foreignFactory), address(wrapped));
        vm.expectRevert(ZeroXFiFactory.InvalidContract.selector);
        factory.scheduleRouter(address(foreignRouter));

        factory.setGuardian(GUARDIAN);
        factory.scheduleRouter(address(replacement));
        uint256 activationTime = factory.pendingRouterActivationTime();
        assertEq(factory.pendingRouter(), address(replacement), "replacement scheduled");
        assertEq(activationTime, block.timestamp + 48 hours, "fixed recovery delay");

        vm.expectRevert();
        vm.prank(GUARDIAN);
        factory.activateRouter();
        vm.expectRevert(ZeroXFiFactory.RouterUpdateNotReady.selector);
        factory.activateRouter();

        vm.prank(GUARDIAN);
        factory.pauseSwaps();
        assertTrue(factory.swapsPaused(), "guardian pauses during recovery delay");
        vm.prank(GUARDIAN);
        factory.cancelRouterUpdate();
        assertEq(factory.pendingRouter(), address(0), "guardian cancelled recovery");
        assertEq(factory.pendingRouterActivationTime(), 0, "cancel clears activation time");

        factory.setSwapsPaused(false);
        factory.scheduleRouter(address(replacement));
        activationTime = factory.pendingRouterActivationTime();
        vm.warp(activationTime - 1);
        vm.expectRevert(ZeroXFiFactory.RouterUpdateNotReady.selector);
        factory.activateRouter();
        vm.warp(activationTime);
        factory.activateRouter();
        assertEq(factory.router(), address(replacement), "owner activates after full delay");
        assertEq(factory.pendingRouter(), address(0), "activation clears pending router");
    }

    function testOnlyFactoryOwnerCanWithdrawAccruedRouterFees() public {
        _seedStandardPair();
        address[] memory path = new address[](2);
        path[0] = address(token);
        path[1] = address(nusd);
        uint256 grossAmount = 100 ether;
        uint256 fee = router.routerFeeFor(grossAmount, path.length);
        vm.prank(BOB);
        router.swapExactTokensForTokens(grossAmount, 0, path, BOB, block.timestamp + 1);

        token.mint(address(router), 5 ether);
        factory.setGuardian(GUARDIAN);
        vm.expectRevert(ZeroXFiRouter.UnauthorizedFeeWithdrawal.selector);
        vm.prank(GUARDIAN);
        router.withdrawRouterFees(address(token), GUARDIAN, fee);
        vm.expectRevert(ZeroXFiRouter.InsufficientRouterFeeBalance.selector);
        router.withdrawRouterFees(address(token), ALICE, fee + 1);

        uint256 aliceBefore = token.balanceOf(ALICE);
        router.withdrawRouterFees(address(token), ALICE, fee);
        assertEq(token.balanceOf(ALICE) - aliceBefore, fee, "owner withdrew accrued fee");
        assertEq(router.accruedRouterFees(address(token)), 0, "accounting cleared");
        assertEq(token.balanceOf(address(router)), 5 ether, "unaccounted donation remains");
    }

    function testDeadlineAndFeeOnTransferAreRejectedAtomically() public {
        ZeroXFiRouter.AddLiquidityParams memory expired = _addParams(ALICE, 1000 ether, 1000 ether);
        expired.deadline = block.timestamp - 1;
        vm.expectRevert(ZeroXFiRouter.DeadlineExpired.selector);
        vm.prank(ALICE);
        router.addLiquidity(expired);

        MockFeeOnTransferToken feeToken = new MockFeeOnTransferToken();
        _fundAndApprove(ALICE, feeToken, 1000 ether);
        ZeroXFiRouter.AddLiquidityParams memory feeParams = ZeroXFiRouter.AddLiquidityParams({
            tokenA: address(feeToken),
            tokenB: address(nusd),
            amountADesired: 1000 ether,
            amountBDesired: 1000 ether,
            amountAMin: 1000 ether,
            amountBMin: 1000 ether,
            minimumLiquidity: 1,
            to: ALICE,
            deadline: block.timestamp + 1
        });
        vm.expectRevert(ZeroXFiRouter.FeeOnTransferUnsupported.selector);
        vm.prank(ALICE);
        router.addLiquidity(feeParams);
        assertEq(factory.getPair(address(feeToken), address(nusd)), address(0), "pair creation rolled back");

        _seedStandardPair();
        address[] memory path = new address[](2);
        path[0] = address(token);
        path[1] = address(nusd);
        uint256 grossAmount = 100 ether;
        uint256 quoted = router.getAmountsOut(grossAmount, path)[1];
        uint256 tokenBefore = token.balanceOf(BOB);
        vm.expectRevert(ZeroXFiRouter.InsufficientOutputAmount.selector);
        vm.prank(BOB);
        router.swapExactTokensForTokens(grossAmount, quoted + 1, path, BOB, block.timestamp + 1);
        assertEq(token.balanceOf(BOB), tokenBefore, "failed swap refunds gross input");
        assertEq(router.accruedRouterFees(address(token)), 0, "failed swap accrues no fee");
    }

    function testGuardianCanOnlyPauseSwapsAndLeavesLpExitOpen() public {
        _seedStandardPair();
        address pair = factory.getPair(address(token), address(nusd));
        assertEq(ZeroXFiPair(pair).factory(), address(factory), "pair pins deploying factory");
        assertEq(factory.guardian(), address(this), "guardian starts as initial owner");

        vm.expectRevert();
        vm.prank(BOB);
        factory.setGuardian(GUARDIAN);

        factory.setGuardian(GUARDIAN);
        assertEq(factory.guardian(), GUARDIAN, "owner replaces guardian");

        vm.expectRevert();
        vm.prank(GUARDIAN);
        factory.setSwapsPaused(false);

        vm.expectRevert();
        vm.prank(GUARDIAN);
        factory.transferOwnership(GUARDIAN);

        vm.prank(GUARDIAN);
        factory.pauseSwaps();
        assertTrue(factory.swapsPaused(), "swaps paused");

        vm.prank(BOB);
        (,, uint256 addedLiquidity) = router.addLiquidity(_addParams(BOB, 1000 ether, 2000 ether));
        assertGt(addedLiquidity, 0, "LP mint remains available");

        address[] memory path = new address[](2);
        path[0] = address(token);
        path[1] = address(nusd);
        vm.expectRevert(ZeroXFiPair.SwapsPaused.selector);
        vm.prank(BOB);
        router.swapExactTokensForTokens(100 ether, 0, path, BOB, block.timestamp + 1);

        uint256 liquidity = IERC20(pair).balanceOf(ALICE) / 2;
        vm.prank(ALICE);
        IERC20(pair).approve(address(router), liquidity);
        vm.prank(ALICE);
        (uint256 tokenOut, uint256 nusdOut) = router.removeLiquidity(
            ZeroXFiRouter.RemoveLiquidityParams({
                tokenA: address(token),
                tokenB: address(nusd),
                liquidity: liquidity,
                amountAMin: 1,
                amountBMin: 1,
                to: ALICE,
                deadline: block.timestamp + 1
            })
        );
        assertGt(tokenOut, 0, "token exit remains available");
        assertGt(nusdOut, 0, "NUSD exit remains available");

        ZeroXFiPair(pair).sync();
        ZeroXFiPair(pair).skim(BOB);

        factory.setSwapsPaused(false);
        assertFalse(factory.swapsPaused(), "only owner restores swaps");
    }

    function testNativeAddSwapAndRemoveRoundTrip() public {
        ZeroXFiRouter.AddLiquidityNativeParams memory addParams = ZeroXFiRouter.AddLiquidityNativeParams({
            token: address(token),
            amountTokenDesired: 1000 ether,
            amountTokenMin: 1000 ether,
            amountNativeMin: 100 ether,
            minimumLiquidity: 1,
            to: ALICE,
            deadline: block.timestamp + 1
        });
        vm.prank(ALICE);
        (,, uint256 liquidity) = router.addLiquidityNative{ value: 100 ether }(addParams);

        address[] memory path = new address[](2);
        path[0] = address(wrapped);
        path[1] = address(token);
        uint256 tokenBefore = token.balanceOf(BOB);
        uint256 nativeRouterFee = router.routerFeeFor(1 ether, path.length);
        vm.prank(BOB);
        router.swapExactNativeForTokens{ value: 1 ether }(0, path, BOB, block.timestamp + 1);
        assertGt(token.balanceOf(BOB), tokenBefore, "native swap output");
        assertEq(router.accruedRouterFees(address(wrapped)), nativeRouterFee, "native fee accrued as WzkLTC");
        assertEq(wrapped.balanceOf(address(router)), nativeRouterFee, "native fee remains fully backed");

        address pair = factory.getPair(address(token), address(wrapped));
        vm.prank(ALICE);
        IERC20(pair).approve(address(router), liquidity);
        uint256 nativeBefore = ALICE.balance;
        vm.prank(ALICE);
        (uint256 tokenOut, uint256 nativeOut) = router.removeLiquidityNative(
            ZeroXFiRouter.RemoveLiquidityNativeParams({
                token: address(token),
                liquidity: liquidity / 2,
                amountTokenMin: 1,
                amountNativeMin: 1,
                to: ALICE,
                deadline: block.timestamp + 1
            })
        );
        assertGt(tokenOut, 0, "removed token");
        assertGt(nativeOut, 0, "removed native");
        assertEq(ALICE.balance, nativeBefore + nativeOut, "native delivered");
    }

    function testFuzzSwapPreservesK(uint96 rawAmountIn) public {
        _seedStandardPair();
        uint256 amountIn = bound(rawAmountIn, 1e12, 10_000 ether);
        address pair = factory.getPair(address(token), address(nusd));
        (uint112 reserve0Before, uint112 reserve1Before,) = ZeroXFiPair(pair).getReserves();
        uint256 kBefore = uint256(reserve0Before) * reserve1Before;

        address[] memory path = new address[](2);
        path[0] = address(token);
        path[1] = address(nusd);
        vm.prank(BOB);
        router.swapExactTokensForTokens(amountIn, 0, path, BOB, block.timestamp + 1);
        uint256 expectedRouterFee = router.routerFeeFor(amountIn, path.length);
        assertEq(router.accruedRouterFees(address(token)), expectedRouterFee, "fuzz router fee accounting");
        assertEq(token.balanceOf(address(router)), expectedRouterFee, "fuzz fee backing");

        (uint112 reserve0After, uint112 reserve1After,) = ZeroXFiPair(pair).getReserves();
        assertGe(uint256(reserve0After) * reserve1After, kBefore, "fuzz k nondecreasing");
    }

    function _seedStandardPair() private {
        vm.prank(ALICE);
        router.addLiquidity(_addParams(ALICE, 100_000 ether, 200_000 ether));
    }

    function _constantProduct(address pair) private view returns (uint256 product) {
        (uint112 reserve0, uint112 reserve1,) = ZeroXFiPair(pair).getReserves();
        product = uint256(reserve0) * reserve1;
    }

    function _addParams(address recipient, uint256 amountToken, uint256 amountNusd)
        private
        view
        returns (ZeroXFiRouter.AddLiquidityParams memory params)
    {
        params = ZeroXFiRouter.AddLiquidityParams({
            tokenA: address(token),
            tokenB: address(nusd),
            amountADesired: amountToken,
            amountBDesired: amountNusd,
            amountAMin: amountToken,
            amountBMin: amountNusd,
            minimumLiquidity: 1,
            to: recipient,
            deadline: block.timestamp + 1
        });
    }

    function _fundAndApprove(address account, MockERC20 asset, uint256 amount) private {
        asset.mint(account, amount);
        vm.prank(account);
        asset.approve(address(router), type(uint256).max);
    }
}
